import { asc, eq, count } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { chat } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'
import { createKnowledgeEntry } from './service.js'
import { extractJsonRobust } from '../lib/json-extract.js'
import { loadGroupCharacters } from '../chat/context.js'
import { autoEvolvePersonality } from '../services/trait.js'
import type { Character, Message } from '../db/schema.js'

// ============================================================
// 记忆提取器: 每 N 条新消息, 用 compressor 模型总结对话
// → 事件/性格标签/关系 → 写入 knowledge_entries (经历时间线)
//
// 私聊 (chat/adventure): 记忆只属于当前角色
// 群聊 (group): 记忆按 speakerName 分配给各参与角色
// ============================================================

/** 每积累多少条新消息触发一次提取 */
const EXTRACT_BATCH = 5
/** 单次提取输入的最大消息条数 */
const MAX_INPUT_MSGS = 10

// 单角色提取 prompt (私聊 / 冒险模式)
const EXTRACT_PROMPT = [
  '你是一个记忆提取器。阅读以下角色扮演对话片段，提取：',
  '1. events: 重要事件摘要（1-3条，每条一句话，含地点/人物/结果）',
  '2. traits: 角色表现出的性格特征或行为模式（2-5个短语，如"勇敢"、"对同伴信任"）',
  '3. relationships: 角色与他人的关系变化（如有，如"与莉莉安关系升温"）',
  '',
  '只输出 JSON，格式：{"events": [...], "traits": [...], "relationships": [...]}',
  '不要输出任何其他内容。',
].join('\n')

// 群聊提取 prompt: 按角色分别提取
const GROUP_EXTRACT_PROMPT = [
  '你是一个群聊记忆提取器。阅读以下群聊对话片段（格式为"角色名: 内容"，玩家消息为"玩家: 内容"），',
  '为每个**实际发言过的角色**分别提取记忆。不要为未发言的角色生成记忆。',
  '',
  '对每个发言角色提取：',
  '- events: 该角色经历或参与的重要事件（1-3条）',
  '- traits: 该角色表现出的性格特征（2-5个短语）',
  '- relationships: 该角色与其他角色/玩家的关系变化（如有）',
  '',
  '只输出 JSON，格式：',
  '{"<角色名1>": {"events": [...], "traits": [...], "relationships": [...]}, "<角色名2>": {...}}',
  '不要输出任何其他内容。',
].join('\n')

/** 写入一组记忆条目 (event/trait/relationship) 到指定角色 */
async function writeMemories(
  ownerId: string,
  parsed: { events?: unknown; traits?: unknown; relationships?: unknown },
  ts: string,
): Promise<number> {
  let written = 0
  const writes: Array<{ type: 'event' | 'trait' | 'relationship'; items: unknown }> = [
    { type: 'event', items: parsed.events },
    { type: 'trait', items: parsed.traits },
    { type: 'relationship', items: parsed.relationships },
  ]
  for (const w of writes) {
    if (!Array.isArray(w.items)) continue
    for (const item of w.items) {
      if (typeof item !== 'string' || !item.trim()) continue
      await createKnowledgeEntry({
        scope: 'character',
        ownerId,
        timestamp: ts,
        type: w.type,
        content: item.trim(),
        importance: w.type === 'event' ? 3 : 2,
      })
      written++
    }
  }
  return written
}

/** 私聊提取: 单角色视角 */
async function extractSingle(
  character: Character,
  msgs: Array<{ role: string; content: string }>,
): Promise<void> {
  const transcript = msgs
    .map((m) => `${m.role === 'user' ? '玩家' : character.name}: ${m.content}`)
    .join('\n')

  let resp = ''
  try {
    resp = await chat(
      [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: transcript },
      ],
      { endpoint: resolveRole('compressor'), temperature: 0.3 },
    )
  } catch (err) {
    console.warn(`[memory] extract failed: ${err instanceof Error ? err.message : err}`)
    return
  }

  const parsed = extractJsonRobust<{ events?: unknown; traits?: unknown; relationships?: unknown }>(
    resp,
    {},
  ).value
  const ts = new Date().toISOString().slice(0, 16)
  const written = await writeMemories(character.id, parsed, ts)
  console.log(`[memory] extracted ${msgs.length} msgs for "${character.name}": ${written} entries`)
}

/** 群聊提取: 按 speakerName 分配给各参与角色 */
async function extractGroup(
  conversationId: string,
  msgs: Message[],
): Promise<void> {
  const chars = await loadGroupCharacters(conversationId)
  if (chars.length < 2) {
    // 退化为单角色提取 (用对话主角色)
    const fallback = await db.query.characters.findFirst({
      where: eq(
        schema.characters.id,
        (await db.query.conversations.findFirst({
          where: eq(schema.conversations.id, conversationId),
        }))?.characterId ?? '',
      ),
    })
    if (fallback) {
      await extractSingle(
        fallback,
        msgs.map((m) => ({ role: m.role, content: m.content })),
      )
    }
    return
  }

  // 构建 transcript: 用户消息标 "玩家", 助手消息标 speakerName (无则标 "旁白")
  const transcript = msgs
    .map((m) => {
      if (m.role === 'user') return `玩家: ${m.content}`
      if (m.role === 'narrator') return `旁白: ${m.content}`
      return `${m.speakerName ?? '未知角色'}: ${m.content}`
    })
    .join('\n')

  let resp = ''
  try {
    resp = await chat(
      [
        { role: 'system', content: GROUP_EXTRACT_PROMPT },
        { role: 'user', content: transcript },
      ],
      { endpoint: resolveRole('compressor'), temperature: 0.3 },
    )
  } catch (err) {
    console.warn(`[memory] group extract failed: ${err instanceof Error ? err.message : err}`)
    return
  }

  const parsed = extractJsonRobust<Record<string, unknown>>(resp, {}).value
  const ts = new Date().toISOString().slice(0, 16)
  // 仅写入实际发言过的角色 (在群成员中匹配名字)
  let totalWritten = 0
  const speakerNames = new Set(
    msgs
      .filter((m) => m.role === 'assistant' && m.speakerName)
      .map((m) => m.speakerName as string),
  )
  for (const ch of chars) {
    if (!speakerNames.has(ch.name)) continue
    const charMem = parsed[ch.name] as
      | { events?: unknown; traits?: unknown; relationships?: unknown }
      | undefined
    if (!charMem || typeof charMem !== 'object') continue
    const written = await writeMemories(ch.id, charMem, ts)
    totalWritten += written
    if (written > 0) {
      console.log(`[memory] group: ${written} entries → "${ch.name}"`)
    }
  }
  console.log(
    `[memory] group extracted ${msgs.length} msgs, ${totalWritten} entries across ${speakerNames.size} speakers`,
  )
}

/** 对话消息数达到阈值时触发提取 (失败静默, 不影响主流程) */
export async function maybeExtractMemories(conversationId: string): Promise<void> {
  try {
    const convo = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    })
    if (!convo) return

    // 群聊模式无需主角色 (但 schema characterId notNull, group 时存第一个成员)
    const character = await db.query.characters.findFirst({
      where: eq(schema.characters.id, convo.characterId),
    })
    if (!character && convo.mode !== 'group') return

    // 计算总消息数与上次提取进度
    const [totalRow] = await db
      .select({ n: count() })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
    const total = totalRow?.n ?? 0
    const extractedThrough = Number(convo.extractedThrough ?? 0)
    if (total - extractedThrough < EXTRACT_BATCH) return

    // 取最近未提取消息 (+ 前几条上下文)
    const msgs = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
      orderBy: [asc(schema.messages.createdAt)],
      offset: Math.max(0, extractedThrough - 3),
      limit: MAX_INPUT_MSGS,
    })
    const batch = msgs.slice(Math.max(0, msgs.length - EXTRACT_BATCH * 2))
    if (batch.length === 0) return

    // 按模式分发
    if (convo.mode === 'group') {
      await extractGroup(conversationId, batch)
      // 群聊: 对所有发言过的角色自动演化
      const chars = await loadGroupCharacters(conversationId)
      for (const ch of chars) {
        try {
          const result = await autoEvolvePersonality(ch.id)
          if (result.evolved) {
            console.log(`[memory] auto-evolved "${ch.name}": +${result.addedTraits.join(', ')}`)
          }
        } catch (err) {
          console.warn(`[memory] auto-evolve failed for "${ch.name}": ${err instanceof Error ? err.message : err}`)
        }
      }
    } else if (character) {
      await extractSingle(
        character,
        batch.map((m) => ({ role: m.role, content: m.content })),
      )
      // 私聊: 对当前角色自动演化
      try {
        const result = await autoEvolvePersonality(character.id)
        if (result.evolved) {
          console.log(`[memory] auto-evolved "${character.name}": +${result.addedTraits.join(', ')}`)
        }
      } catch (err) {
        console.warn(`[memory] auto-evolve failed for "${character.name}": ${err instanceof Error ? err.message : err}`)
      }
    }

    // 更新提取进度
    await db
      .update(schema.conversations)
      .set({ extractedThrough: String(total) })
      .where(eq(schema.conversations.id, conversationId))
  } catch (err) {
    console.warn(`[memory] maybeExtractMemories failed: ${err instanceof Error ? err.message : err}`)
  }
}
