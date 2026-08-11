// ============================================================
// worldsmith — 共享类型定义 (client / server 共用)
// ============================================================

// ---------- 世界 ----------
// 多世界架构: 每个世界独立隔离角色/对话/地图/状态/记忆/GM对话
// characters.worldId 为 null 表示"角色库" (跨世界共享, 可导入到任意世界)

export interface World {
  id: string
  name: string
  description: string
  /** 排序权重, 数字越小越靠前 */
  sortOrder: number
  createdAt: string
  updatedAt: string
}

// ---------- 玩家人设 (User Persona) ----------
// 让 AI 知道"玩家是谁", 注入到所有对话模式的 system prompt
// 同一时刻只有一个 isActive=true 的 persona

export interface UserPersona {
  id: string
  name: string
  /** 玩家角色描述: 性格/背景/说话风格/偏好等 */
  description: string
  avatar?: string | null
  /** 是否为当前激活的人设 (全局唯一) */
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// ---------- LLM 配置 ----------

/** LLM 角色映射：不同任务可指向不同厂商/模型 */
export type LlmRole = 'gm' | 'character' | 'compressor' | 'embedding'

export interface LlmModelConfig {
  id: string
  name?: string
  contextWindow?: number
}

export interface LlmProviderConfig {
  id: string
  name: string
  baseUrl: string
  /** 支持 ${env:XXX} 引用环境变量 */
  apiKey: string
  models: LlmModelConfig[]
  capabilities?: string[]
}

export interface LlmConfig {
  activeProvider: string
  providers: LlmProviderConfig[]
  /** 格式: "providerId/modelId" */
  roleMapping: Record<LlmRole, string>
  defaults: {
    temperature: number
    maxTokens: number
    streaming: boolean
  }
}

// ---------- 角色卡 ----------

export interface CharacterBlockField {
  key: string
  label: string
  value: string
  /** code = 代码引擎可计算字段, narrative = 注入 LLM 的叙事字段 */
  kind: 'code' | 'narrative'
}

export interface CharacterBlock {
  id: string
  /** basic | stats | equipment | custom */
  type: string
  title: string
  fields: CharacterBlockField[]
  order: number
}

export interface Character {
  id: string
  name: string
  avatar?: string | null
  /** 人格锚点, 逗号分隔关键词 — 固定层, 每次请求原样注入 */
  personality: string
  background: string
  appearance?: string | null
  firstMessage?: string | null
  scenario?: string | null
  tags?: string[] | null
  /** 板块化角色卡 */
  blocks?: CharacterBlock[] | null
  /** 所属世界 ID; null = 角色库 (跨世界共享) */
  worldId?: string | null
  createdAt: string
  updatedAt: string
}

// ---------- 对话 ----------

export interface Conversation {
  id: string
  characterId: string
  mode: 'chat' | 'adventure' | 'group'
  title?: string | null
  /** 所属世界 ID */
  worldId: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'narrator'
  content: string
  speakerName?: string | null
  createdAt: string
}

// ---------- 通用响应 ----------

export interface ApiError {
  error: string
}

// ---------- GM 结局 ----------

export interface GmOutcome {
  id: string
  gmMessageId: string
  skillName: string
  skillArgs: Record<string, unknown>
  codeResult: unknown
  gmNarrative: string
  playerChoice: 'gm' | 'code' | 'custom'
  playerCustom: string | null
  createdAt: string
}

// ---------- 世界地图 ----------

export type LocationType = 'town' | 'forest' | 'mountain' | 'lake' | 'dungeon' | 'other'

export interface WorldLocation {
  id: string
  name: string
  description: string
  type: LocationType
  x: number
  y: number
  tags: string[]
  /** 所属世界 ID */
  worldId: string
  createdAt: string
  updatedAt: string
}

export interface LocationConnection {
  id: string
  fromId: string
  toId: string
}

export interface WorldMap {
  locations: WorldLocation[]
  connections: LocationConnection[]
}

// ---------- Lorebook ----------

export interface LoreEntry {
  id: string
  keys: string[]
  content: string
  priority: number
  enabled: boolean
  /** 所属世界 ID */
  worldId: string
  createdAt: string
  updatedAt: string
}

// ---------- 玩家运行时状态 ----------

export interface PlayerState {
  id: string
  /** 状态键名, 如 'hp'/'location'/'time' */
  key: string
  /** 显示标签 */
  label: string
  /** 状态值 */
  value: string
  /** lucide 图标名 */
  icon: string
  /** 所属世界 ID */
  worldId: string
  updatedAt: string
}

// ---------- 角色运行时状态 (动态角色卡) ----------
// 类似 player_states, 但关联到具体角色; GM 通过 skill 维护
// 用于体现角色在剧情中的动态变化 (心情/位置/好感度/HP 等)

export interface CharacterState {
  id: string
  /** 关联角色 ID */
  characterId: string
  /** 状态键名, 如 'mood'/'location'/'relationship'/'hp' */
  key: string
  /** 显示标签 */
  label: string
  /** 状态值 */
  value: string
  /** lucide 图标名 */
  icon: string
  /** 所属世界 ID */
  worldId: string
  updatedAt: string
}

// ---------- 世界导出包 ----------
// 删除世界时可导出的世界设定快照

export interface WorldExport {
  world: { name: string; description: string }
  locations: WorldLocation[]
  connections: LocationConnection[]
  loreEntries: LoreEntry[]
  playerStates: PlayerState[]
  quests: Array<{
    name: string
    location: string
    description: string
    importance: number
  }>
  exportedAt: string
}

// ---------- 世界规则 (World Rules) ----------
// 世界级别的规则设定, GM agent 和玩家都可编写
// 按世界隔离 (worldId), 注入到所有对话的 system prompt
// author: 'gm' = GM agent 通过 skill 创建, 'player' = 玩家通过 UI 创建

export type WorldRuleCategory = 'system' | 'combat' | 'magic' | 'world' | 'other'
export type WorldRuleAuthor = 'gm' | 'player'

export interface WorldRule {
  id: string
  title: string
  content: string
  category: WorldRuleCategory
  author: WorldRuleAuthor
  enabled: boolean
  /** 所属世界 ID */
  worldId: string
  createdAt: string
  updatedAt: string
}
