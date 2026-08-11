import { createHash } from 'node:crypto'
import { eq, asc, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { Character, Conversation, Message } from '../db/schema.js'
import type { ChatMsg } from '../llm/client.js'

// ============================================================
// 角色块缓存: 角色卡 → 注入文本, 内容 hash 指纹, 变化才重编译
// ============================================================

interface CachedBlock {
  hash: string
  content: string
}

const cache = new Map<string, CachedBlock>()

/** 角色卡 → 稳定指纹 (任何字段变化都会改变 hash) */
function fingerprint(character: Character): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        name: character.name,
        personality: character.personality,
        background: character.background,
        appearance: character.appearance,
        scenario: character.scenario,
        firstMessage: character.firstMessage,
      }),
    )
    .digest('hex')
}

/** 角色卡 → 注入 AI 上下文的文本块 (人格锚点最前, 权重最高) */
function compileBlock(character: Character): string {
  const parts: string[] = []

  if (character.personality) {
    parts.push(`【人格锚点】${character.personality}`)
  }
  if (character.background) {
    parts.push(`【背景故事】\n${character.background}`)
  }
  if (character.appearance) {
    parts.push(`【外观】${character.appearance}`)
  }
  if (character.scenario) {
    parts.push(`【当前场景】\n${character.scenario}`)
  }

  // 板块化角色卡: 注入 narrative 字段 (code 字段供代码引擎, 不注入 LLM)
  if (Array.isArray(character.blocks) && character.blocks.length > 0) {
    const sorted = [...character.blocks].sort((a, b) => a.order - b.order)
    for (const block of sorted) {
      const narrativeFields = block.fields.filter((f) => f.kind === 'narrative')
      if (narrativeFields.length === 0) continue
      const lines = narrativeFields
        .map((f) => (f.label ? `${f.label}: ${f.value}` : f.value))
        .filter((l) => l.trim())
      if (lines.length > 0) {
        parts.push(`【${block.title}】\n${lines.join('\n')}`)
      }
    }
  }

  return parts.join('\n\n')
}

/** 获取角色块 (缓存命中直接返回, 未命中或指纹变化则重编译) */
export function getCharacterBlock(character: Character): string {
  const hash = fingerprint(character)
  const cached = cache.get(character.id)
  if (cached && cached.hash === hash) {
    return cached.content
  }
  const content = compileBlock(character)
  cache.set(character.id, { hash, content })
  return content
}

/** 主动失效缓存 (角色被删除时调用) */
export function invalidateCharacterBlock(characterId: string): void {
  cache.delete(characterId)
}

export function cacheSize(): number {
  return cache.size
}

/** 文本标记格式指令 (SillyTavern 风格, 注入到所有对话模式) */
const FORMAT_GUIDE = [
  '【输出格式】使用以下标记语法增强表现力：',
  '- 动作/心理描写用 *星号* 包裹，如 *她微微一笑*',
  '- 台词用中文引号「」或""包裹，如 "你好"',
  '- 重点强调用 **双星号** 包裹',
  '- 出戏/元信息用 ((双括号)) 包裹',
].join('\n')

/** 组装 system prompt: 角色扮演指令 + 角色块 */
export function buildSystemPrompt(character: Character): string {
  const block = getCharacterBlock(character)
  return [
    `你正在角色扮演游戏中扮演"${character.name}"。`,
    '请完全沉浸于角色，始终保持人设，用第一人称回应。',
    '永远不要跳出角色，不要提及你是AI或语言模型，不要解释你的行为。',
    '',
    FORMAT_GUIDE,
    '',
    block,
  ].join('\n')
}

// ============================================================
// 对话模式上下文组装: 三种模式 (chat / adventure / group) 各自独立
// ============================================================

/** 上下文组装结果 */
export interface AssembledContext {
  system: string
  msgs: ChatMsg[]
}

/** 加载群聊成员角色列表 (按 joinOrder 排序)
 *  优化: 用 inArray 一次查完所有角色, 避免 N+1 查询 */
export async function loadGroupCharacters(conversationId: string): Promise<Character[]> {
  const members = await db.query.groupMembers.findMany({
    where: eq(schema.groupMembers.conversationId, conversationId),
    orderBy: [asc(schema.groupMembers.joinOrder)],
  })
  if (members.length === 0) return []
  // 单次查询拉取所有成员角色, 再按 joinOrder 排序
  const chars = await db.query.characters.findMany({
    where: inArray(
      schema.characters.id,
      members.map((m) => m.characterId),
    ),
  })
  const charMap = new Map(chars.map((c) => [c.id, c]))
  return members
    .map((m) => charMap.get(m.characterId))
    .filter((c): c is Character => Boolean(c))
}

/** 群聊模式上下文: 多角色 + speaker 格式 */
export async function assembleGroupContext(
  character: Character,
  conversationId: string,
  userMsgId: string,
  history: Message[],
): Promise<AssembledContext> {
  const chars = await loadGroupCharacters(conversationId)
  if (chars.length < 2) {
    throw new Error('group conversation needs at least 2 characters')
  }
  const blocks = chars.map((c) => getCharacterBlock(c))
  const system = [
    `你在一个群聊中，在场角色: ${chars.map((c) => c.name).join('、')}。`,
    '每次回复时，从在场角色中选择一个最适合回应当前对话的角色，以「角色名: 内容」格式输出。',
    '尽量让不同角色轮流发言，不要连续让同一角色说两次。',
    '可以描写动作或场景，但保持角色扮演，不要跳出角色。',
    '',
    FORMAT_GUIDE,
    '',
    ...blocks.map((b, i) => `【角色 ${chars[i].name}】\n${b}`),
  ].join('\n\n')

  const msgs: ChatMsg[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      msgs.push({
        role: 'assistant',
        content: m.speakerName ? `${m.speakerName}: ${m.content}` : m.content,
      })
    }
  }
  return { system, msgs }
}

/** 冒险模式上下文: GM 叙事者 (第二人称 + NPC 扮演) */
export function assembleAdventureContext(
  character: Character,
  history: Message[],
): AssembledContext {
  const system = [
    `你是一个文字冒险游戏的 Game Master。玩家扮演的角色是「${character.name}」（${character.personality || '无设定'}）。`,
    '你负责：',
    '1. 用第二人称叙述场景、环境与事件（"你推开酒馆的门，一股麦酒味扑面而来..."）',
    '2. 扮演所有 NPC 并与玩家对话（NPC 台词用「角色名:」标注）',
    '3. 裁定玩家行动的结果，必要时设置合理的挑战或意外',
    '4. 保持故事连贯，每次回应 2-4 段；描述玩家所见所感，但绝不要替玩家做决定',
    '',
    FORMAT_GUIDE,
    '',
    `【玩家角色信息】\n${getCharacterBlock(character)}`,
  ].join('\n')

  const msgs: ChatMsg[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant' || m.role === 'narrator') {
      msgs.push({ role: 'assistant', content: m.content })
    }
  }
  return { system, msgs }
}

/** 单角色模式上下文: 角色开场白 + 历史消息 */
export function assembleChatContext(
  character: Character,
  history: Message[],
): AssembledContext {
  const system = buildSystemPrompt(character)
  const msgs: ChatMsg[] = [{ role: 'system', content: system }]
  // 角色开场白作为历史首条 (酒馆惯例)
  if (character.firstMessage) {
    msgs.push({ role: 'assistant', content: character.firstMessage })
  }
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      msgs.push({ role: m.role, content: m.content })
    }
    // system/narrator 消息暂不注入 (Phase 3 处理)
  }
  return { system, msgs }
}

/** 解析群聊 speaker 前缀 ("角色名: 内容"), 角色名须为群成员 */
export async function parseGroupSpeaker(
  conversationId: string,
  content: string,
): Promise<{ speakerName: string | null; content: string }> {
  const chars = await loadGroupCharacters(conversationId)
  const names = chars.map((c) => c.name)
  const match = /^([^:：]{1,20})[:：]\s*/.exec(content)
  if (match && names.includes(match[1])) {
    return { speakerName: match[1], content: content.slice(match[0].length) }
  }
  return { speakerName: null, content }
}

// ============================================================
// 玩家人设 (User Persona) 注入
// 全局单例: 同一时刻仅一个 isActive=true, 跨世界一致
// 注入到所有对话模式的 system prompt, 让 AI 知道"玩家是谁"
// ============================================================

/** 获取当前激活的玩家人设 (无则返回 null) */
export async function getActivePersona(): Promise<string | null> {
  const persona = await db.query.userPersonas.findFirst({
    where: eq(schema.userPersonas.isActive, true),
  })
  if (!persona || (!persona.name && !persona.description)) return null
  const parts: string[] = []
  if (persona.name) parts.push(`姓名: ${persona.name}`)
  if (persona.description) parts.push(persona.description)
  return `【玩家身份】\n${parts.join('\n')}`
}

/** 获取当前对话所属世界的规则块 (仅启用的规则) */
export async function getWorldRulesBlock(worldId: string): Promise<string | null> {
  const rules = await db.query.worldRules.findMany({
    where: (r, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(r.worldId, worldId), eqFn(r.enabled, true)),
  })
  if (rules.length === 0) return null
  const lines = rules.map((r) => {
    const tag = r.author === 'gm' ? 'GM设定' : '玩家设定'
    return `[${tag}·${r.category}] ${r.title}: ${r.content}`
  })
  return `【世界规则】(角色与GM必须严格遵守以下规则)\n${lines.join('\n')}`
}

/** 按对话模式组装上下文 (注入玩家人设 + 世界规则) */
export async function assembleContext(
  convo: Conversation,
  character: Character,
  userMsgId: string,
  history: Message[],
): Promise<AssembledContext> {
  // 先按模式组装基础上下文
  let result: AssembledContext
  switch (convo.mode) {
    case 'group':
      result = await assembleGroupContext(character, convo.id, userMsgId, history)
      break
    case 'adventure':
      result = assembleAdventureContext(character, history)
      break
    default:
      result = assembleChatContext(character, history)
  }
  // 注入到 system prompt 最前 (权重高): 玩家人设 + 世界规则
  // 并行拉取: 两者无依赖关系, 串行会多一个 RTT
  const [personaBlock, rulesBlock] = await Promise.all([
    getActivePersona(),
    getWorldRulesBlock(convo.worldId),
  ])
  const prefixParts: string[] = []
  if (personaBlock) prefixParts.push(personaBlock)
  if (rulesBlock) prefixParts.push(rulesBlock)
  if (prefixParts.length > 0) {
    const systemMsg = result.msgs.find((m) => m.role === 'system')
    if (systemMsg) {
      systemMsg.content = `${prefixParts.join('\n\n')}\n\n${systemMsg.content}`
    }
  }
  return result
}
