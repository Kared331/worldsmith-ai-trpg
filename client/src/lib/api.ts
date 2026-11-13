import type {
  Character,
  CharacterBlock,
  Conversation,
  ChatMessage,
  GmOutcome,
  World,
  WorldExport,
  WorldLocation,
  WorldMap,
  LlmConfig,
  LlmRole,
  PlayerState,
  CharacterState,
  UserPersona,
  WorldRule,
  LoreEntry,
} from '@worldsmith/shared'

// ============================================================
// API 客户端: 所有 HTTP 调用统一入口, store 不应直接使用 fetch
// 多世界: 通过 setWorldHeader 设置当前世界, 所有请求自动带 x-world-id
// ============================================================

/** 默认世界 ID (与 server DEFAULT_WORLD_ID 对齐) */
export const DEFAULT_WORLD_ID = 'default-world'

// ============================================================
// 当前世界的单一数据源
// 原先这里自持一份 `currentWorldId`, 与 store 的 activeWorld 各自维护,
// 靠手工 setWorldHeader 同步 —— 一旦漏调 (loadWorlds 的兜底分支就漏了)
// 就会出现「UI 显示世界 A、请求打向世界 B」。
// 现在改为由 store 注入读取函数, 彻底消除双数据源。
// ============================================================
let worldSource: () => string | null = () => null

/** 绑定当前世界的读取源 (store 创建后调用一次) */
export function bindWorldSource(fn: () => string | null): void {
  worldSource = fn
}

/** 获取当前世界 ID (未选世界时兜底默认世界) */
export function getWorldHeader(): string {
  return worldSource() ?? DEFAULT_WORLD_ID
}

/** 合并 headers, 自动注入 x-world-id */
function withWorldHeaders(init?: RequestInit): RequestInit {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-world-id': getWorldHeader(),
  }
  if (!init?.headers) return { ...init, headers: baseHeaders }
  // 合并已有 headers (调用方显式传入的优先)
  const merged =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init.headers as Record<string, string>)
  return {
    ...init,
    headers: { ...baseHeaders, ...merged, 'x-world-id': getWorldHeader() },
  }
}

/** 普通 JSON 请求 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, withWorldHeaders(init))
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 二进制请求 (下载 PNG 角色卡等) */
async function requestBlob(url: string, init?: RequestInit): Promise<Blob> {
  const res = await fetch(url, withWorldHeaders(init))
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.blob()
}

/** SSE 流式事件 (与 server StreamEvent 对齐) */
export interface StreamEvent {
  type: 'delta' | 'done' | 'error' | 'thinking'
  text?: string
  messageId?: string
  ooc?: string[]
  message?: string
}

/** SSE 流式请求, 返回事件 async generator
 *  @param signal 中止信号 (切世界/切对话/发新消息时由 store abort) */
export async function* streamSse(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-world-id': getWorldHeader(),
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    // 读取服务器返回的错误详情 (当前只显示状态码, 会丢失 zod 校验等原因)
    let detail = ''
    try {
      const text = await res.text()
      if (text) {
        try {
          detail = JSON.parse(text).error ?? text.slice(0, 300)
        } catch {
          detail = text.slice(0, 300)
        }
      }
    } catch {
      // 忽略读取失败
    }
    throw new Error(`stream failed: ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  /** 解析一个完整 SSE 帧并 yield; 单帧坏 JSON 只跳过该帧, 不中断整条流 */
  function* parseFrames(frames: string[]): Generator<StreamEvent> {
    for (const frame of frames) {
      const line = frame.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        yield JSON.parse(payload) as StreamEvent
      } catch {
        // 代理插入的心跳/注释帧, 或被截断的帧: 跳过
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    yield* parseFrames(frames)
  }

  // 流结束: flush 解码器残留的多字节字符, 并处理最后一帧
  // (服务端最后一个事件可能未以 \n\n 结尾, 此时它会留在 buf 里被丢弃)
  buf += decoder.decode()
  yield* parseFrames(buf.split('\n\n'))
}

/** 性格演变建议响应 */
export interface TraitSuggestionResponse {
  suggestion: {
    trait: string
    count: number
    currentPersonality: string
    gmText: string
  } | null
  reason?: string
  traitStats?: Array<{ trait: string; count: number }>
}

export const api = {
  // ---------- 角色 ----------
  getCharacters: () => request<Character[]>('/api/characters'),
  createCharacter: (data: Partial<Character>) =>
    request<Character>('/api/characters', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCharacter: (id: string, data: Partial<Character>) =>
    request<Character>(`/api/characters/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCharacter: (id: string) =>
    request<void>(`/api/characters/${id}`, { method: 'DELETE' }),
  /** 自然语言编辑角色卡: LLM 解析指令 → 返回修改后的 blocks (不保存) */
  editCharacterNatural: (id: string, instruction: string) =>
    request<{ blocks: CharacterBlock[]; instruction: string }>(
      `/api/characters/${id}/edit-natural`,
      { method: 'POST', body: JSON.stringify({ instruction }) },
    ),
  /** 性格演变建议 (统计 trait → 达阈值时由 GM 生成建议) */
  suggestTrait: (characterId: string) =>
    request<TraitSuggestionResponse>(`/api/characters/${characterId}/suggest-trait`, {
      method: 'POST',
    }),

  // ---------- PNG 角色卡 (导入/导出必须走这里, 否则丢失 x-world-id 头) ----------
  /** 导入 PNG 角色卡 → 在当前世界创建角色 */
  importCharacterCard: (base64Png: string) =>
    request<Character>('/api/cards/import', {
      method: 'POST',
      body: JSON.stringify({ base64Png }),
    }),
  /** 导出角色为 PNG 角色卡 (返回二进制) */
  exportCharacterCard: (characterId: string) =>
    requestBlob(`/api/cards/export/${characterId}`),

  // ---------- 对话 ----------
  getConversations: (characterId?: string) =>
    request<Conversation[]>(
      `/api/conversations${characterId ? `?characterId=${characterId}` : ''}`,
    ),
  createConversation: (characterId: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ characterId, mode: 'chat' }),
    }),
  createGroupConversation: (characterIds: string[]) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ characterIds, mode: 'group' }),
    }),
  createAdventureConversation: (characterId: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ characterId, mode: 'adventure' }),
    }),
  /** 切换对话模式 (chat↔adventure↔group); 切到 group 需传 characterIds */
  updateConversationMode: (
    id: string,
    mode: 'chat' | 'adventure' | 'group',
    characterIds?: string[],
  ) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode, characterIds }),
    }),
  /** 重命名对话标题 (传 null 清空) */
  renameConversation: (id: string, title: string | null) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  /** 删除对话 (级联删除消息和群成员) */
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),
  getGroupMembers: (conversationId: string) =>
    request<Array<{ characterId: string; character: Character | null }>>(
      `/api/conversations/${conversationId}/members`,
    ),
  getMessages: (conversationId: string) =>
    request<ChatMessage[]>(`/api/conversations/${conversationId}/messages`),
  /** 编辑单条消息 */
  editMessage: (conversationId: string, messageId: string, content: string) =>
    request<ChatMessage>(`/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  /** 删除单条消息 */
  deleteMessage: (conversationId: string, messageId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    }),
  /** 重新生成最后一条 AI 回复 (SSE) */
  regenerate: (conversationId: string, signal?: AbortSignal) =>
    streamSse(`/api/conversations/${conversationId}/regenerate`, {}, signal),
  /** 从指定消息处分叉出新对话 */
  forkConversation: (conversationId: string, messageId: string) =>
    request<Conversation>(`/api/conversations/${conversationId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  // ---------- 对话流式 ----------
  streamChat: (conversationId: string, content: string, signal?: AbortSignal) =>
    streamSse('/api/chat', { conversationId, content }, signal),

  // ---------- GM 元对话 ----------
  getGmMessages: () => request<ChatMessage[]>('/api/gm/messages'),
  streamGmChat: (content: string, conversationId?: string, signal?: AbortSignal) =>
    streamSse(
      '/api/gm/chat',
      conversationId ? { content, conversationId } : { content },
      signal,
    ),
  getGmOutcomes: () => request<GmOutcome[]>('/api/gm/outcomes'),
  chooseOutcome: (
    id: string,
    choice: 'gm' | 'code' | 'custom',
    customText?: string,
  ) =>
    request<GmOutcome>(`/api/gm/outcomes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ choice, customText }),
    }),

  // ---------- 世界知识 (Lorebook) ----------
  getLore: () => request<LoreEntry[]>('/api/lore'),
  createLore: (data: {
    keys: string[]
    content: string
    priority?: number
    enabled?: boolean
  }) => request<LoreEntry>('/api/lore', { method: 'POST', body: JSON.stringify(data) }),
  updateLore: (
    id: string,
    data: Partial<{ keys: string[]; content: string; priority: number; enabled: boolean }>,
  ) =>
    request<LoreEntry>(`/api/lore/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteLore: (id: string) => request<void>(`/api/lore/${id}`, { method: 'DELETE' }),
  /** 导入 SillyTavern 世界书 JSON (World Info) */
  importLore: (payload: unknown) =>
    request<{ imported: number; skipped: number }>('/api/lore/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ---------- 数据备份 ----------
  /** 下载整库备份 (VACUUM INTO 一致性快照) */
  backupDatabase: () => requestBlob('/api/system/backup'),
  /** 上传备份, 重启服务后生效 */
  restoreDatabase: (file: File) =>
    request<{ ok: boolean; message: string }>('/api/system/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }),

  // ---------- 世界地图 ----------
  getWorld: () => request<WorldMap>('/api/locations'),
  createLocation: (data: Partial<WorldLocation>) =>
    request<WorldLocation>('/api/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateLocation: (id: string, data: Partial<WorldLocation>) =>
    request<WorldLocation>(`/api/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteLocation: (id: string) =>
    request<void>(`/api/locations/${id}`, { method: 'DELETE' }),

  // ---------- LLM 配置 ----------
  getLlmConfig: () => request<LlmConfig>('/api/llm/config'),
  updateLlmConfig: (config: LlmConfig) =>
    request<LlmConfig>('/api/llm/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  updateDefaults: (defaults: LlmConfig['defaults']) =>
    request<LlmConfig>('/api/llm/defaults', {
      method: 'PUT',
      body: JSON.stringify(defaults),
    }),
  updateRoleMapping: (roleMapping: Record<LlmRole, string>) =>
    request<LlmConfig>('/api/llm/role-mapping', {
      method: 'PUT',
      body: JSON.stringify(roleMapping),
    }),
  updateProviderApiKey: (providerId: string, apiKey: string) =>
    request<{ ok: boolean }>(`/api/llm/providers/${providerId}/api-key`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  scanProviderModels: (providerId: string) =>
    request<{ models: string[] }>(`/api/llm/providers/${providerId}/scan-models`, {
      method: 'POST',
    }),
  updateProviderModels: (
    providerId: string,
    models: Array<{ id: string; name?: string; contextWindow?: number }>,
  ) =>
    request<LlmConfig>(`/api/llm/providers/${providerId}/models`, {
      method: 'PUT',
      body: JSON.stringify({ models }),
    }),

  // ---------- 玩家状态 ----------
  getPlayerStates: () => request<PlayerState[]>('/api/player-state'),
  upsertPlayerState: (data: { key: string; value: string; label?: string; icon?: string }) =>
    request<PlayerState>('/api/player-state', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePlayerState: (key: string) =>
    request<void>(`/api/player-state/${key}`, { method: 'DELETE' }),

  // ---------- 角色状态 (动态角色卡) ----------
  /** 查询角色状态; 不传参数返回当前世界所有角色状态 */
  getCharacterStates: (characterId?: string) =>
    request<CharacterState[]>(
      `/api/character-state${characterId ? `?characterId=${characterId}` : ''}`,
    ),
  /** 批量查询多个角色状态 (群聊场景) */
  getCharacterStatesBatch: (characterIds: string[]) =>
    request<CharacterState[]>(
      `/api/character-state?characterIds=${characterIds.join(',')}`,
    ),
  upsertCharacterState: (
    characterId: string,
    data: { key: string; value: string; label?: string; icon?: string },
  ) =>
    request<CharacterState>(`/api/character-state/${characterId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCharacterState: (characterId: string, key: string) =>
    request<void>(`/api/character-state/${characterId}/${key}`, { method: 'DELETE' }),

  // ---------- 世界管理 ----------
  // worlds 路由本身不隔离 (管理多世界本身), 但仍会带 x-world-id 头 (无副作用)
  getWorlds: () => request<World[]>('/api/worlds'),
  createWorld: (data: { name: string; description?: string }) =>
    request<World>('/api/worlds', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorld: (id: string, data: { name?: string; description?: string }) =>
    request<World>(`/api/worlds/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  exportWorld: (id: string) => request<WorldExport>(`/api/worlds/${id}/export`),
  /** 删除世界; keepCharacters=true 把角色移入角色库, exportSettings=true 同时返回设定快照 */
  deleteWorld: (
    id: string,
    options: { keepCharacters?: boolean; exportSettings?: boolean },
  ) =>
    request<{
      deleted: boolean
      worldId: string
      worldName: string
      keptCharacters: boolean
      exportData: WorldExport | null
    }>(`/api/worlds/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(options),
    }),

  // ---------- 角色库 ----------
  // worldId 为 null 的角色, 跨世界共享; 可导入到任意世界 (复制副本)
  getLibraryCharacters: () =>
    request<Character[]>('/api/worlds/library/characters'),
  importCharacterToWorld: (characterId: string, targetWorldId: string) =>
    request<Character>(
      `/api/worlds/library/characters/${characterId}/import?worldId=${encodeURIComponent(targetWorldId)}`,
      { method: 'POST' },
    ),
  /** 把当前世界的角色移到角色库 (worldId 设为 null) */
  detachCharacterToLibrary: (characterId: string) =>
    request<Character>(
      `/api/worlds/library/characters/${characterId}/detach`,
      { method: 'POST' },
    ),

  // ---------- 玩家人设 (User Persona) ----------
  getActivePersona: () => request<UserPersona | null>('/api/personas/active'),
  upsertActivePersona: (data: { name: string; description?: string; avatar?: string }) =>
    request<UserPersona>('/api/personas/active', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  clearActivePersona: () =>
    request<void>('/api/personas/active', { method: 'DELETE' }),

  // ---------- 世界规则 (World Rules) ----------
  // 按世界隔离, GM agent 和玩家都可编写
  getWorldRules: () => request<WorldRule[]>('/api/rules'),
  createWorldRule: (data: {
    title: string
    content: string
    category?: WorldRule['category']
    author?: WorldRule['author']
  }) =>
    request<WorldRule>('/api/rules', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorldRule: (
    id: string,
    data: Partial<Pick<WorldRule, 'title' | 'content' | 'category' | 'enabled'>>,
  ) =>
    request<WorldRule>(`/api/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteWorldRule: (id: string) =>
    request<void>(`/api/rules/${id}`, { method: 'DELETE' }),
}
