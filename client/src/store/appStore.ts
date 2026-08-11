import { create } from 'zustand'
import type {
  Character,
  Conversation,
  ChatMessage,
  GmOutcome,
  World,
  WorldExport,
  WorldLocation,
  LocationConnection,
  PlayerState,
  CharacterState,
  UserPersona,
  WorldRule,
} from '@worldsmith/shared'
import { api, setWorldHeader, DEFAULT_WORLD_ID, type StreamEvent } from '../lib/api'
import { toast } from '../components/ui/Toast'

// 带重试的 API 调用 (解决 vite proxy 启动竞态)
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 500): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (retries <= 0) throw err
    await new Promise((r) => setTimeout(r, delay))
    return withRetry(fn, retries - 1, delay * 2)
  }
}

// ============================================================
// appStore: 全局状态 (角色 / 对话 / GM / 世界地图)
// 所有 HTTP 调用统一走 lib/api, 不直接使用 fetch
// SSE 解析逻辑统一在 api.streamSse, store 只处理业务事件
// ============================================================

export type { StreamEvent }

interface AppState {
  // ---------- 世界 ----------
  worlds: World[]
  activeWorld: World | null
  loadWorlds: () => Promise<void>
  createWorld: (data: { name: string; description?: string }) => Promise<World | null>
  updateWorld: (id: string, data: { name?: string; description?: string }) => Promise<void>
  exportWorld: (id: string) => Promise<WorldExport | null>
  deleteWorld: (
    id: string,
    options: { keepCharacters?: boolean; exportSettings?: boolean },
  ) => Promise<{ exportData: WorldExport | null } | null>
  /** 切换当前世界: 同步 header + 清空业务状态 + 重新加载 */
  switchWorld: (id: string) => Promise<void>

  characters: Character[]
  activeCharacter: Character | null
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null

  gmMessages: ChatMessage[]
  gmStreaming: boolean
  gmThinking: boolean
  gmError: string | null
  gmOutcomes: GmOutcome[]

  loadCharacters: () => Promise<void>
  createCharacter: (data: Partial<Character>) => Promise<void>
  updateCharacter: (id: string, data: Partial<Character>) => Promise<void>
  deleteCharacter: (id: string) => Promise<void>
  selectCharacter: (id: string) => Promise<void>
  createGroupConversation: (characterIds: string[]) => Promise<void>
  createAdventureConversation: (characterId: string) => Promise<void>
  /** 切换当前对话模式 (chat↔adventure↔group); 切到 group 需传 characterIds */
  switchConversationMode: (
    mode: 'chat' | 'adventure' | 'group',
    characterIds?: string[],
  ) => Promise<void>
  selectConversation: (conversation: Conversation) => Promise<void>
  /** 重命名当前对话标题 */
  renameConversation: (id: string, title: string) => Promise<void>
  /** 删除对话 (级联删除消息和群成员) */
  deleteConversation: (id: string) => Promise<void>
  exitConversation: () => void
  refreshMessages: () => Promise<void>
  sendMessage: (content: string) => Promise<void>

  loadGmMessages: () => Promise<void>
  sendGmMessage: (content: string) => Promise<void>
  loadGmOutcomes: () => Promise<void>
  chooseOutcome: (
    id: string,
    choice: 'gm' | 'code' | 'custom',
    customText?: string,
  ) => Promise<void>

  locations: WorldLocation[]
  connections: LocationConnection[]
  selectedLocation: WorldLocation | null
  directorMode: boolean
  loadWorld: () => Promise<void>
  createLocation: (data: Partial<WorldLocation>) => Promise<void>
  updateLocation: (id: string, data: Partial<WorldLocation>) => Promise<void>
  deleteLocation: (id: string) => Promise<void>
  selectLocation: (loc: WorldLocation | null) => void
  toggleDirectorMode: () => void

  // LLM 配置面板开关
  llmConfigOpen: boolean
  setLlmConfigOpen: (open: boolean) => void

  // 玩家运行时状态 (GM skill 维护)
  playerStates: PlayerState[]
  loadPlayerStates: () => Promise<void>
  upsertPlayerState: (data: { key: string; value: string; label?: string; icon?: string }) => Promise<void>
  deletePlayerState: (key: string) => Promise<void>

  // 角色运行时状态 (动态角色卡, GM skill 维护)
  // 按世界隔离: 存储当前世界所有角色的动态状态, 前端按 characterId 分组展示
  characterStates: CharacterState[]
  loadCharacterStates: () => Promise<void>
  upsertCharacterState: (
    characterId: string,
    data: { key: string; value: string; label?: string; icon?: string },
  ) => Promise<void>
  deleteCharacterState: (characterId: string, key: string) => Promise<void>

  // ---------- 角色库 ----------
  libraryCharacters: Character[]
  loadLibraryCharacters: () => Promise<void>
  importCharacterToWorld: (characterId: string) => Promise<void>
  detachCharacterToLibrary: (characterId: string) => Promise<void>

  // ---------- 玩家人设 (User Persona) ----------
  activePersona: UserPersona | null
  personaDialogOpen: boolean
  setPersonaDialogOpen: (open: boolean) => void
  loadActivePersona: () => Promise<void>
  saveActivePersona: (data: { name: string; description?: string; avatar?: string }) => Promise<void>
  clearActivePersona: () => Promise<void>

  // ---------- 世界规则 (World Rules) ----------
  // 按世界隔离, GM agent 和玩家都可编写; 切换世界时重载
  worldRules: WorldRule[]
  rulesDialogOpen: boolean
  setRulesDialogOpen: (open: boolean) => void
  loadWorldRules: () => Promise<void>
  createWorldRule: (data: {
    title: string
    content: string
    category?: WorldRule['category']
  }) => Promise<void>
  updateWorldRule: (
    id: string,
    data: Partial<Pick<WorldRule, 'title' | 'content' | 'category' | 'enabled'>>,
  ) => Promise<void>
  deleteWorldRule: (id: string) => Promise<void>
}

export const useAppStore = create<AppState>()((set, get) => ({
  // ---------- 世界 ----------
  worlds: [],
  activeWorld: null,
  async loadWorlds() {
    try {
      const worlds = await withRetry(() => api.getWorlds())
      // 首次加载: 若无 activeWorld, 选第一个 (或默认世界) 并同步 header
      const current = get().activeWorld
      if (!current && worlds.length > 0) {
        const fallback =
          worlds.find((w) => w.id === DEFAULT_WORLD_ID) ?? worlds[0]
        setWorldHeader(fallback.id)
        set({ worlds, activeWorld: fallback })
      } else if (current) {
        // activeWorld 已存在, 更新引用为最新数据 (可能被改名)
        const updated = worlds.find((w) => w.id === current.id) ?? null
        set({ worlds, activeWorld: updated ?? worlds[0] ?? null })
      } else {
        set({ worlds })
      }
    } catch {
      toast.error('世界列表加载失败')
    }
  },
  async createWorld(data) {
    try {
      const world = await api.createWorld(data)
      set((s) => ({ worlds: [...s.worlds, world] }))
      return world
    } catch (err) {
      toast.error('创建世界失败')
      return null
    }
  },
  async updateWorld(id, data) {
    try {
      const updated = await api.updateWorld(id, data)
      set((s) => ({
        worlds: s.worlds.map((w) => (w.id === id ? updated : w)),
        activeWorld: s.activeWorld?.id === id ? updated : s.activeWorld,
      }))
    } catch {
      toast.error('世界更新失败')
    }
  },
  async exportWorld(id) {
    try {
      return await api.exportWorld(id)
    } catch {
      toast.error('世界设定导出失败')
      return null
    }
  },
  async deleteWorld(id, options) {
    try {
      const result = await api.deleteWorld(id, options)
      // 删除后从列表移除, 若删的是当前世界则切回默认世界
      const remaining = (await api.getWorlds()).filter((w) => w.id !== id)
      const current = get().activeWorld
      if (current?.id === id) {
        const fallback =
          remaining.find((w) => w.id === DEFAULT_WORLD_ID) ?? remaining[0] ?? null
        if (fallback) {
          await get().switchWorld(fallback.id)
        } else {
          setWorldHeader(DEFAULT_WORLD_ID)
          set({ activeWorld: null, worlds: remaining })
        }
      } else {
        set({ worlds: remaining })
      }
      return { exportData: result.exportData }
    } catch {
      toast.error('世界删除失败')
      return null
    }
  },
  async switchWorld(id) {
    const world = get().worlds.find((w) => w.id === id)
    if (!world) return
    // 1. 同步 API header (必须在加载前, 确保后续请求带正确 worldId)
    setWorldHeader(world.id)
    // 2. 清空所有业务状态 (避免跨世界残留)
    //    数据重载由 App.tsx 的 useEffect (依赖 activeWorld) 统一触发, 避免重复请求
    set({
      activeWorld: world,
      characters: [],
      activeCharacter: null,
      conversations: [],
      activeConversation: null,
      messages: [],
      streamError: null,
      gmMessages: [],
      gmOutcomes: [],
      gmError: null,
      locations: [],
      connections: [],
      selectedLocation: null,
      playerStates: [],
      characterStates: [],
      libraryCharacters: [],
      worldRules: [],
    })
  },

  characters: [],
  activeCharacter: null,
  conversations: [],
  activeConversation: null,
  messages: [],
  streaming: false,
  streamError: null,

  gmMessages: [],
  gmStreaming: false,
  gmThinking: false,
  gmError: null,
  gmOutcomes: [],
  locations: [],
  connections: [],
  selectedLocation: null,
  directorMode: false,

  llmConfigOpen: false,
  setLlmConfigOpen: (open) => set({ llmConfigOpen: open }),

  // ---------- 角色库 ----------
  libraryCharacters: [],
  async loadLibraryCharacters() {
    try {
      const libraryCharacters = await api.getLibraryCharacters()
      set({ libraryCharacters })
    } catch {
      // 静默失败
    }
  },
  async importCharacterToWorld(characterId) {
    const world = get().activeWorld
    if (!world) {
      toast.error('请先选择一个世界')
      return
    }
    try {
      const imported = await api.importCharacterToWorld(characterId, world.id)
      set((s) => ({ characters: [...s.characters, imported] }))
      toast.success(`已导入「${imported.name}」到当前世界`)
    } catch {
      toast.error('角色导入失败')
    }
  },
  async detachCharacterToLibrary(characterId) {
    try {
      await api.detachCharacterToLibrary(characterId)
      // 从当前世界角色列表移除
      set((s) => ({
        characters: s.characters.filter((c) => c.id !== characterId),
        activeCharacter:
          s.activeCharacter?.id === characterId ? null : s.activeCharacter,
      }))
      toast.success('角色已移入角色库')
    } catch {
      toast.error('角色移出失败')
    }
  },

  playerStates: [],
  async loadPlayerStates() {
    try {
      const playerStates = await api.getPlayerStates()
      set({ playerStates })
    } catch {
      // 静默失败
    }
  },
  async upsertPlayerState(data) {
    try {
      const updated = await api.upsertPlayerState(data)
      set((s) => {
        const exists = s.playerStates.some((p) => p.key === data.key)
        return {
          playerStates: exists
            ? s.playerStates.map((p) => (p.key === data.key ? updated : p))
            : [...s.playerStates, updated],
        }
      })
    } catch {
      toast.error('状态更新失败')
    }
  },
  async deletePlayerState(key) {
    try {
      await api.deletePlayerState(key)
      set((s) => ({ playerStates: s.playerStates.filter((p) => p.key !== key) }))
    } catch {
      // 静默失败
    }
  },

  // ---------- 角色状态 (动态角色卡) ----------
  characterStates: [],
  async loadCharacterStates() {
    try {
      // 无参数: 返回当前世界所有角色的动态状态
      const characterStates = await api.getCharacterStates()
      set({ characterStates })
    } catch {
      // 静默失败
    }
  },
  async upsertCharacterState(characterId, data) {
    try {
      const updated = await api.upsertCharacterState(characterId, data)
      set((s) => {
        // 按 (characterId, key) 复合定位
        const exists = s.characterStates.some(
          (p) => p.characterId === characterId && p.key === data.key,
        )
        return {
          characterStates: exists
            ? s.characterStates.map((p) =>
                p.characterId === characterId && p.key === data.key ? updated : p,
              )
            : [...s.characterStates, updated],
        }
      })
    } catch {
      toast.error('角色状态更新失败')
    }
  },
  async deleteCharacterState(characterId, key) {
    try {
      await api.deleteCharacterState(characterId, key)
      set((s) => ({
        characterStates: s.characterStates.filter(
          (p) => !(p.characterId === characterId && p.key === key),
        ),
      }))
    } catch {
      // 静默失败
    }
  },

  // ---------- 玩家人设 ----------
  activePersona: null,
  personaDialogOpen: false,
  setPersonaDialogOpen: (open) => set({ personaDialogOpen: open }),
  async loadActivePersona() {
    try {
      const activePersona = await api.getActivePersona()
      set({ activePersona })
    } catch {
      // 静默失败
    }
  },
  async saveActivePersona(data) {
    try {
      const activePersona = await api.upsertActivePersona(data)
      set({ activePersona })
      toast.success('玩家人设已保存')
    } catch {
      toast.error('人设保存失败')
    }
  },
  async clearActivePersona() {
    try {
      await api.clearActivePersona()
      set({ activePersona: null })
      toast.success('已清除玩家人设')
    } catch {
      toast.error('清除人设失败')
    }
  },

  // ---------- 世界规则 ----------
  worldRules: [],
  rulesDialogOpen: false,
  setRulesDialogOpen: (open) => set({ rulesDialogOpen: open }),
  async loadWorldRules() {
    try {
      const worldRules = await api.getWorldRules()
      set({ worldRules })
    } catch {
      // 静默失败
    }
  },
  async createWorldRule(data) {
    try {
      const rule = await api.createWorldRule({ ...data, author: 'player' })
      set({ worldRules: [rule, ...get().worldRules] })
      toast.success('规则已创建')
    } catch {
      toast.error('创建规则失败')
    }
  },
  async updateWorldRule(id, data) {
    try {
      const updated = await api.updateWorldRule(id, data)
      set({
        worldRules: get().worldRules.map((r) => (r.id === id ? updated : r)),
      })
      toast.success('规则已更新')
    } catch {
      toast.error('更新规则失败')
    }
  },
  async deleteWorldRule(id) {
    try {
      await api.deleteWorldRule(id)
      set({ worldRules: get().worldRules.filter((r) => r.id !== id) })
      toast.success('规则已删除')
    } catch {
      toast.error('删除规则失败')
    }
  },

  async loadCharacters() {
    try {
      const characters = await withRetry(() => api.getCharacters())
      set({ characters })
    } catch {
      toast.error('角色列表加载失败')
    }
  },

  async createCharacter(data) {
    const character = await api.createCharacter(data)
    set((s) => ({ characters: [...s.characters, character] }))
    await get().selectCharacter(character.id)
  },

  async updateCharacter(id, data) {
    const updated = await api.updateCharacter(id, data)
    set((s) => ({
      characters: s.characters.map((c) => (c.id === id ? updated : c)),
      activeCharacter: s.activeCharacter?.id === id ? updated : s.activeCharacter,
    }))
  },

  async deleteCharacter(id) {
    await api.deleteCharacter(id)
    set((s) => ({
      characters: s.characters.filter((c) => c.id !== id),
      activeCharacter: s.activeCharacter?.id === id ? null : s.activeCharacter,
      activeConversation: null,
      messages: [],
    }))
  },

  async selectCharacter(id) {
    const character = get().characters.find((c) => c.id === id)
    if (!character) return
    // 复用该角色最近的对话, 没有则创建
    const conversations = await api.getConversations(id)
    let conversation = conversations[0] ?? null
    if (!conversation) {
      conversation = await api.createConversation(id)
      conversations.unshift(conversation)
    }
    set({ activeCharacter: character, conversations, activeConversation: conversation })
    await get().refreshMessages()
    get().loadCharacterStates()
  },

  async refreshMessages() {
    const conv = get().activeConversation
    if (!conv) return
    const messages = await api.getMessages(conv.id)
    set({ messages })
  },

  async createGroupConversation(characterIds) {
    const conversation = await api.createGroupConversation(characterIds)
    set({
      activeCharacter: null,
      activeConversation: conversation,
      conversations: [conversation],
    })
    await get().refreshMessages()
    get().loadCharacterStates()
  },

  async createAdventureConversation(characterId) {
    const character = get().characters.find((c) => c.id === characterId)
    if (!character) return
    const conversation = await api.createAdventureConversation(characterId)
    set({
      activeCharacter: character,
      activeConversation: conversation,
      conversations: [conversation],
    })
    await get().refreshMessages()
    get().loadCharacterStates()
  },

  async switchConversationMode(mode, characterIds) {
    const conv = get().activeConversation
    if (!conv || conv.mode === mode) return
    try {
      const updated = await api.updateConversationMode(
        conv.id,
        mode,
        characterIds,
      )
      // group 模式下 activeCharacter 置空; 其他模式按 characterId 还原
      const activeCharacter =
        mode === 'group'
          ? null
          : (get().characters.find((c) => c.id === updated.characterId) ?? null)
      set({
        activeConversation: updated,
        activeCharacter,
        conversations: get().conversations.map((c) =>
          c.id === updated.id ? updated : c,
        ),
      })
      await get().refreshMessages()
      get().loadCharacterStates()
      const label =
        mode === 'group' ? '群聊剧场' : mode === 'adventure' ? '文字冒险' : '角色扮演'
      toast.success(`已切换为${label}模式`)
    } catch {
      toast.error('模式切换失败')
    }
  },

  async selectConversation(conversation) {
    set({ activeConversation: conversation })
    await get().refreshMessages()
    get().loadCharacterStates()
  },

  async renameConversation(id, title) {
    try {
      const updated = await api.renameConversation(id, title || null)
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
        activeConversation: s.activeConversation?.id === id ? updated : s.activeConversation,
      }))
      toast.success('对话已重命名')
    } catch {
      toast.error('重命名失败')
    }
  },

  async deleteConversation(id) {
    try {
      await api.deleteConversation(id)
      const current = get().activeConversation
      set((s) => ({
        conversations: s.conversations.filter((c) => c.id !== id),
        // 删除的是当前对话: 清空活跃状态
        activeConversation: current?.id === id ? null : current,
        activeCharacter: current?.id === id ? null : get().activeCharacter,
        messages: current?.id === id ? [] : get().messages,
        streamError: null,
      }))
      toast.success('对话已删除')
    } catch {
      toast.error('删除对话失败')
    }
  },

  exitConversation() {
    set({
      activeCharacter: null,
      activeConversation: null,
      messages: [],
      streamError: null,
    })
  },

  async sendMessage(content) {
    const conv = get().activeConversation
    if (!conv || get().streaming) return
    // /gm 前缀 → 剧情模式: GM 回复以 narrator 消息注入主对话框
    if (content.startsWith('/gm') || content.startsWith('/GM')) {
      const gmContent = content.replace(/^\/gm\s*/i, '').trim()
      if (!gmContent) return

      // 本地显示"对 GM 说"消息 + narrator 流式占位
      const userGmMsg: ChatMessage = {
        id: `local-gm-${Date.now()}`,
        conversationId: conv.id,
        role: 'user',
        content: gmContent,
        speakerName: '__gm_command__',
        createdAt: new Date().toISOString(),
      }
      const narratorPlaceholder: ChatMessage = {
        id: 'streaming',
        conversationId: conv.id,
        role: 'narrator',
        content: '',
        createdAt: new Date().toISOString(),
      }
      set((s) => ({
        messages: [...s.messages, userGmMsg, narratorPlaceholder],
        streaming: true,
        streamError: null,
      }))

      try {
        let accumulated = ''
        let finalId = ''
        for await (const ev of api.streamGmChat(gmContent, conv.id)) {
          if (ev.type === 'delta' && ev.text) {
            accumulated += ev.text
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === 'streaming' ? { ...m, content: accumulated } : m,
              ),
            }))
          } else if (ev.type === 'thinking') {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === 'streaming' && !m.content
                  ? { ...m, content: '…' }
                  : m,
              ),
            }))
          } else if (ev.type === 'done') {
            if (ev.messageId) finalId = ev.messageId
          } else if (ev.type === 'error') {
            set({ streamError: ev.message ?? 'unknown error' })
          }
        }
        // 用服务器返回的 id 替换占位 id (不调 refreshMessages, 保留"对 GM 说"本地消息)
        if (finalId) {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === 'streaming' ? { ...m, id: finalId } : m,
            ),
          }))
        }
      } catch (err) {
        set({ streamError: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ streaming: false })
        // GM 可能修改了世界数据
        get().loadCharacters()
        get().loadWorld()
        get().loadPlayerStates()
        get().loadCharacterStates()
      }
      return
    }

    // 本地立即追加用户消息
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      conversationId: conv.id,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      messages: [...s.messages, userMsg],
      streaming: true,
      streamError: null,
    }))

    // 流式占位
    const placeholder: ChatMessage = {
      id: 'streaming',
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }
    set((s) => ({ messages: [...s.messages, placeholder] }))

    try {
      let accumulated = ''
      for await (const ev of api.streamChat(conv.id, content)) {
        if (ev.type === 'delta' && ev.text) {
          accumulated += ev.text
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === 'streaming' ? { ...m, content: accumulated } : m,
            ),
          }))
        } else if (ev.type === 'error') {
          set({ streamError: ev.message ?? 'unknown error' })
        }
        // done: 从服务端重新拉取最终落库消息 (finally 块处理)
      }
    } catch (err) {
      set({ streamError: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ streaming: false })
      await get().refreshMessages()
    }
  },

  async loadGmMessages() {
    try {
      const gmMessages = await withRetry(() => api.getGmMessages())
      set({ gmMessages })
    } catch {
      toast.error('GM 消息加载失败')
    }
  },

  async loadGmOutcomes() {
    try {
      const gmOutcomes = await withRetry(() => api.getGmOutcomes())
      set({ gmOutcomes })
    } catch {
      toast.error('GM 结局加载失败')
    }
  },

  async chooseOutcome(id, choice, customText) {
    try {
      const updated = await api.chooseOutcome(id, choice, customText)
      set((s) => ({
        gmOutcomes: s.gmOutcomes.map((o) => (o.id === id ? updated : o)),
      }))
    } catch {
      // 静默失败
    }
  },

  async sendGmMessage(content) {
    if (get().gmStreaming) return
    const userMsg: ChatMessage = {
      id: `gm-local-${Date.now()}`,
      conversationId: 'gm',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      gmMessages: [...s.gmMessages, userMsg],
      gmStreaming: true,
      gmError: null,
    }))

    const placeholder: ChatMessage = {
      id: 'gm-streaming',
      conversationId: 'gm',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }
    set((s) => ({ gmMessages: [...s.gmMessages, placeholder] }))

    try {
      let accumulated = ''
      for await (const ev of api.streamGmChat(content)) {
        if (ev.type === 'delta' && ev.text) {
          accumulated += ev.text
          set((s) => ({
            gmMessages: s.gmMessages.map((m) =>
              m.id === 'gm-streaming' ? { ...m, content: accumulated } : m,
            ),
          }))
        } else if (ev.type === 'thinking') {
          set({ gmThinking: true })
        } else if (ev.type === 'error') {
          set({ gmError: ev.message ?? 'unknown error' })
        }
      }
    } catch (err) {
      set({ gmError: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ gmStreaming: false, gmThinking: false })
      await get().loadGmMessages()
      // GM skill 可能修改了角色/地图/状态, 刷新前端数据
      get().loadCharacters()
      get().loadWorld()
      get().loadPlayerStates()
    }
  },

  async loadWorld() {
    try {
      const map = await withRetry(() => api.getWorld())
      set({ locations: map.locations, connections: map.connections })
    } catch {
      toast.error('世界地图加载失败')
    }
  },

  async createLocation(data) {
    try {
      await api.createLocation(data)
      await get().loadWorld()
    } catch {
      // 静默失败
    }
  },

  async updateLocation(id, data) {
    try {
      await api.updateLocation(id, data)
      await get().loadWorld()
    } catch {
      // 静默失败
    }
  },

  async deleteLocation(id) {
    try {
      await api.deleteLocation(id)
    } finally {
      set((s) => ({
        selectedLocation: s.selectedLocation?.id === id ? null : s.selectedLocation,
      }))
      await get().loadWorld()
    }
  },

  selectLocation(loc) {
    set({ selectedLocation: loc })
  },

  toggleDirectorMode() {
    set((s) => ({ directorMode: !s.directorMode }))
  },
}))
