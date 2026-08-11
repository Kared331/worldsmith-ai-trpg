import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import type { CharacterBlock } from '@worldsmith/shared'

// ============================================================
// 多世界架构: 所有业务表通过 world_id 隔离
// characters.worldId 可空 (null = 角色库, 跨世界共享)
// gm_messages / gm_outcomes 也按世界隔离, 避免跨世界 GM 记忆污染
// ============================================================

// ---------- 世界 ----------
export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** 排序权重, 数字越小越靠前 */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ---------- 角色卡 ----------
// worldId 为 null 表示"角色库" (跨世界共享, 不属于任何世界)
export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** 人格锚点，逗号分隔关键词 */
    personality: text('personality').notNull().default(''),
    background: text('background').notNull().default(''),
    appearance: text('appearance'),
    firstMessage: text('first_message'),
    scenario: text('scenario'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    avatar: text('avatar'),
    /** 板块化角色卡: [{id,type,title,fields:[{key,label,value,kind}],order}] */
    blocks: text('blocks', { mode: 'json' })
      .$type<CharacterBlock[]>()
      .default([]),
    /** 所属世界 ID; null = 角色库 (跨世界共享) */
    worldId: text('world_id').references(() => worlds.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('characters_world_idx').on(t.worldId)],
)

// ---------- 对话 ----------
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['chat', 'adventure', 'group'] })
      .notNull()
      .default('chat'),
    title: text('title'),
    /** 记忆提取进度: 上次提取到的消息 id (null = 未提取) */
    extractedThrough: text('extracted_through'),
    /** 所属世界 ID (必填, 对话必然属于某世界) */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('conversations_character_idx').on(t.characterId),
    index('conversations_world_idx').on(t.worldId),
  ],
)

// ---------- 消息 ----------
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'narrator'] })
      .notNull(),
    content: text('content').notNull(),
    speakerName: text('speaker_name'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
)

// ---------- 知识条目 (角色经历 / 世界 Lore / 场景信息 统一抽象) ----------
// scope=character 时 ownerId = 角色 ID (角色记忆, 随角色走)
// scope=world 时 ownerId = 世界 ID (世界任务/事件, 随世界走)
export const knowledgeEntries = sqliteTable(
  'knowledge_entries',
  {
    id: text('id').primaryKey(),
    /** character | world | scene */
    scope: text('scope').notNull(),
    /** 所属角色ID 或 世界ID */
    ownerId: text('owner_id').notNull(),
    /** 游戏内时间戳, 如 "第4天·黄昏" */
    timestamp: text('timestamp').notNull(),
    /** event | trait | relationship | lore | quest */
    type: text('type').notNull(),
    content: text('content').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    importance: integer('importance').notNull().default(3),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('knowledge_owner_idx').on(t.ownerId)],
)

// ---------- 群聊成员 ----------
export const groupMembers = sqliteTable(
  'group_members',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    joinOrder: integer('join_order').notNull().default(0),
  },
  (t) => [index('group_members_conv_idx').on(t.conversationId)],
)

// ---------- GM 元对话 (按世界隔离, 避免跨世界 GM 记忆污染) ----------
export const gmMessages = sqliteTable(
  'gm_messages',
  {
    id: text('id').primaryKey(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    /** 所属世界 ID (GM 记忆按世界隔离) */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('gm_messages_world_idx').on(t.worldId)],
)

// ---------- GM 结局记录: 代码引擎判定 vs GM 叙事, 玩家可切换 ----------
export const gmOutcomes = sqliteTable('gm_outcomes', {
  id: text('id').primaryKey(),
  gmMessageId: text('gm_message_id')
    .notNull()
    .references(() => gmMessages.id, { onDelete: 'cascade' }),
  skillName: text('skill_name').notNull(),
  skillArgs: text('skill_args', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  codeResult: text('code_result', { mode: 'json' }).$type<unknown>().notNull(),
  gmNarrative: text('gm_narrative').notNull(),
  playerChoice: text('player_choice', {
    enum: ['gm', 'code', 'custom'],
  })
    .notNull()
    .default('gm'),
  playerCustom: text('player_custom'),
  createdAt: text('created_at').notNull(),
})

// ---------- 世界地图: 地点节点 ----------
export const locations = sqliteTable(
  'locations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    type: text('type', {
      enum: ['town', 'forest', 'mountain', 'lake', 'dungeon', 'other'],
    })
      .notNull()
      .default('other'),
    x: integer('x').notNull().default(0),
    y: integer('y').notNull().default(0),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    /** 所属世界 ID */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('locations_world_idx').on(t.worldId)],
)

// ---------- 世界地图: 地点连线 ----------
// 连线通过 fromId/toId 间接关联世界, 不单独存 worldId
export const locationConnections = sqliteTable(
  'location_connections',
  {
    id: text('id').primaryKey(),
    fromId: text('from_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [index('connections_from_idx').on(t.fromId)],
)

// ---------- 玩家运行时状态 (GM skill 维护, 动态可增删) ----------
// (key, worldId) 复合唯一: 不同世界可有相同 key (如 "hp")
export const playerStates = sqliteTable(
  'player_states',
  {
    id: text('id').primaryKey(),
    /** 状态键名, 如 'hp'/'location'/'time'/'inventory' */
    key: text('key').notNull(),
    /** 显示标签, 如 'HP'/'位置' */
    label: text('label').notNull(),
    /** 状态值 (字符串存储, 前端按需解析) */
    value: text('value').notNull(),
    /** lucide 图标名, 默认 Activity */
    icon: text('icon').notNull().default('Activity'),
    /** 所属世界 ID */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('player_states_world_idx').on(t.worldId),
    index('player_states_key_world_idx').on(t.key, t.worldId),
  ],
)

// ---------- 角色运行时状态 (动态角色卡) ----------
// 类似 player_states, 但关联到具体角色; GM 可通过 skill 维护角色动态状态
// (characterId, key, worldId) 复合唯一: 同一角色在同一世界可有相同 key 的不同实例
export const characterStates = sqliteTable(
  'character_states',
  {
    id: text('id').primaryKey(),
    /** 关联角色 ID */
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** 状态键名, 如 'mood'/'location'/'relationship'/'hp' */
    key: text('key').notNull(),
    /** 显示标签, 如 '心情'/'位置'/'好感度' */
    label: text('label').notNull(),
    /** 状态值 (字符串存储, 前端按需解析) */
    value: text('value').notNull(),
    /** lucide 图标名, 默认 Activity */
    icon: text('icon').notNull().default('Activity'),
    /** 所属世界 ID (角色状态仍按世界隔离, 防止跨世界污染) */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('character_states_world_idx').on(t.worldId),
    index('character_states_character_idx').on(t.characterId),
    index('character_states_key_char_world_idx').on(t.key, t.characterId, t.worldId),
  ],
)

// ---------- Lorebook: 世界书条目 (关键词触发注入) ----------
export const loreEntries = sqliteTable(
  'lore_entries',
  {
    id: text('id').primaryKey(),
    /** 触发关键词数组, 任一命中即注入 */
    keys: text('keys', { mode: 'json' }).$type<string[]>().notNull(),
    content: text('content').notNull(),
    /** 优先级, 数字越大越靠前 */
    priority: integer('priority').notNull().default(1),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** 所属世界 ID */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('lore_entries_world_idx').on(t.worldId)],
)

// ---------- 玩家人设 (User Persona) ----------
// 让 AI 知道"玩家是谁", 注入到所有对话模式的 system prompt
// 全局表 (不按世界隔离): 玩家身份跨世界一致; 同一时刻仅一个 isActive=true
export const userPersonas = sqliteTable('user_personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  avatar: text('avatar'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ---------- 世界规则 (World Rules) ----------
// 世界级别的规则设定, GM agent 和玩家都可编写
// 按世界隔离 (worldId 外键), 注入到所有对话的 system prompt
// author: 'gm' = GM agent 通过 skill 创建, 'player' = 玩家通过 UI 创建
export const worldRules = sqliteTable(
  'world_rules',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    /** 规则分类: system/combat/magic/world/other */
    category: text('category').notNull().default('other'),
    /** 作者: gm = GM agent, player = 玩家 */
    author: text('author').notNull().default('player'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** 所属世界 ID */
    worldId: text('world_id')
      .notNull()
      .default('default-world')
      .references(() => worlds.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('world_rules_world_idx').on(t.worldId)],
)

export type World = typeof worlds.$inferSelect
export type Character = typeof characters.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect
export type GmMessage = typeof gmMessages.$inferSelect
export type GmOutcome = typeof gmOutcomes.$inferSelect
export type Location = typeof locations.$inferSelect
export type LocationConnection = typeof locationConnections.$inferSelect
export type LoreEntry = typeof loreEntries.$inferSelect
export type GroupMember = typeof groupMembers.$inferSelect
export type PlayerState = typeof playerStates.$inferSelect
export type CharacterState = typeof characterStates.$inferSelect
export type UserPersona = typeof userPersonas.$inferSelect
export type WorldRule = typeof worldRules.$inferSelect

// 角色卡板块类型 (CharacterBlock / CharacterBlockField) 统一由 @worldsmith/shared 定义
// 此处 drizzle schema 通过 $type<CharacterBlock[]>() 引用 shared 类型, 不再重复声明
