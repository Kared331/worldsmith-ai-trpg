import { randomUUID } from 'node:crypto'
import { eq, desc, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { streamChat, LlmError, chatWithTools, type ChatMsg } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'
import { skillDefs, executeSkill } from '../skills/index.js'
import { getWorldRulesBlock } from '../chat/context.js'
import { getPrompts } from '../chat/prompts.js'
import type { Conversation } from '../db/schema.js'

// ============================================================
// GMService: Game Master 元对话 — 独立于角色扮演叙事流
// 唤醒方式: GM 面板输入 / 主对话框 /gm 前缀 / 关键事件(Phase2)
// ============================================================

const GM_HISTORY_LIMIT = 30

// GM 元对话 system prompt 见 server/prompts.json 的 "gm" 字段 (可热更新)

// ============================================================
// 剧情模式 system prompt: GM 作为"说书人"推动剧情
// 与元对话模式不同: 侧重叙事输出, 可安排角色台词
// ============================================================

// 剧情模式 system prompt 见 server/prompts.json 的 "gmStory" 字段 (可热更新)

export type GmStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking' }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string }

const MAX_TOOL_ROUNDS = 5

/** 会产生"结局"的技能: 代码判定与 GM 叙事可能冲突, 需记录供玩家选择 */
const OUTCOME_SKILLS = new Set(['roll_attack', 'roll_skill_check'])

/**
 * 构造当前世界的轻量快照 (注入 GM system prompt, 减少 GM 编造)
 * 只列名字/关键属性, 不列详情; GM 需要详情时用 get_world_state / update_* skill
 */
async function getWorldSnapshot(worldId: string): Promise<string> {
  const [characters, locations, quests, playerStates] = await Promise.all([
    db.query.characters.findMany({
      where: eq(schema.characters.worldId, worldId),
      columns: { name: true, personality: true },
    }),
    db.query.locations.findMany({
      where: eq(schema.locations.worldId, worldId),
      columns: { name: true, type: true },
    }),
    db.query.knowledgeEntries.findMany({
      where: (k, { and: andFn, eq: eqFn }) =>
        andFn(eqFn(k.scope, 'world'), eqFn(k.ownerId, worldId), eqFn(k.type, 'quest')),
      columns: { tags: true },
    }),
    db.query.playerStates.findMany({
      where: eq(schema.playerStates.worldId, worldId),
      columns: { key: true, label: true, value: true },
    }),
  ])

  const parts: string[] = []
  parts.push(`【当前世界快照】(基于系统事实, GM 不得编造下列名单外的人物/地点)`)
  parts.push(
    `角色(${characters.length}): ${characters.length ? characters.map((c) => `${c.name}${c.personality ? `(${c.personality})` : ''}`).join('、') : '无'}`,
  )
  parts.push(
    `地点(${locations.length}): ${locations.length ? locations.map((l) => `${l.name}[${l.type}]`).join('、') : '无'}`,
  )
  parts.push(
    `任务(${quests.length}): ${quests.length ? quests.map((q) => q.tags?.[0] ?? '未命名').join('、') : '无'}`,
  )
  parts.push(
    `玩家状态(${playerStates.length}): ${playerStates.length ? playerStates.map((p) => `${p.label ?? p.key}=${p.value}`).join('、') : '无'}`,
  )
  return parts.join('\n')
}

export class GmService {
  /** @param signal 调用方中止信号 (客户端断开时路由层会 abort) */
  async *streamMessage(
    userContent: string,
    worldId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GmStreamEvent> {
    // 1. 保存用户消息 (带世界隔离, mode='meta' 元对话)
    const userMsgId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: userMsgId,
      role: 'user',
      content: userContent,
      worldId,
      mode: 'meta',
      createdAt: new Date().toISOString(),
    })

    // 2. 组装上下文: system (静态职责 + 世界规则 + 世界快照) + 最近历史
    //    只拉取 mode='meta' 的历史, 隔离剧情模式 (/GM) 的消息
    const [history, rulesBlock, snapshot] = await Promise.all([
      db.query.gmMessages.findMany({
        where: and(
          eq(schema.gmMessages.worldId, worldId),
          eq(schema.gmMessages.mode, 'meta'),
        ),
        orderBy: [desc(schema.gmMessages.createdAt)],
        limit: GM_HISTORY_LIMIT,
      }),
      getWorldRulesBlock(worldId),
      getWorldSnapshot(worldId),
    ])
    history.reverse()

    // 拼接 system prompt: 静态职责 + 世界规则 + 世界快照
    const systemParts = [getPrompts().gm]
    if (rulesBlock) systemParts.push(rulesBlock)
    systemParts.push(snapshot)

    const msgs: Array<Record<string, unknown>> = [
      { role: 'system', content: systemParts.join('\n\n') },
    ]
    for (const m of history) {
      if (m.id === userMsgId) {
        msgs.push({ role: 'user', content: m.content })
      } else {
        msgs.push({ role: m.role, content: m.content })
      }
    }

    // 3. 工具调用循环: chatWithTools → 执行 Skill → 结果回填 → 继续 (最多 MAX_TOOL_ROUNDS 轮)
    let full = ''
    const outcomeRecords: Array<{
      skillName: string
      skillArgs: Record<string, unknown>
      codeResult: unknown
    }> = []
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // 每次 LLM 调用前先反馈, 避免思考期(可长达数十秒)前端无任何事件看起来像卡死
        yield { type: 'thinking' }
        const { text, toolCalls } = await chatWithTools(msgs, skillDefs, {
          endpoint: resolveRole('gm'),
          temperature: 0.7,
          signal,
        })
        if (toolCalls.length === 0) {
          full = text
          break
        }
        msgs.push({
          role: 'assistant',
          content: text,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        })
        for (const tc of toolCalls) {
          // 注入 worldId 到 skill args, 让 skill 知道在哪个世界操作
          const skillArgs = { ...tc.arguments, _worldId: worldId }
          const result = await executeSkill(tc.name, skillArgs)
          if (OUTCOME_SKILLS.has(tc.name)) {
            outcomeRecords.push({
              skillName: tc.name,
              skillArgs: tc.arguments,
              codeResult: result,
            })
          }
          msgs.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          })
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          full = text || '（工具调用达到上限，请简化请求）'
        }
      }

      // 4. 模拟流式: 按块产出最终文本
      const CHUNK = 12
      for (let i = 0; i < full.length; i += CHUNK) {
        yield { type: 'delta', text: full.slice(i, i + CHUNK) }
      }
    } catch (err) {
      const msg = err instanceof LlmError ? err.message : `gm chat failed: ${String(err)}`
      yield { type: 'error', message: msg }
      return
    }

    // 4. 保存助手消息 + 结局记录 (mode='meta' 元对话)
    const assistantId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: assistantId,
      role: 'assistant',
      content: full,
      worldId,
      mode: 'meta',
      createdAt: new Date().toISOString(),
    })
    for (const rec of outcomeRecords) {
      await db.insert(schema.gmOutcomes).values({
        id: randomUUID(),
        gmMessageId: assistantId,
        skillName: rec.skillName,
        skillArgs: rec.skillArgs,
        codeResult: rec.codeResult,
        gmNarrative: full,
        playerChoice: 'gm',
        createdAt: new Date().toISOString(),
      })
    }
    yield { type: 'done', messageId: assistantId }
  }

  // ============================================================
  // 剧情模式: GM 回复以 narrator 消息注入主对话框
  // 玩家的 /GM 指令不存入 chat_messages (角色不可见)
  // GM 回复存入 chat_messages 的 narrator 角色 (chat 模式下不注入角色上下文)
  // 同时存一份到 gm_messages 保留元对话记录
  // ============================================================
  async *streamToConversation(
    userContent: string,
    worldId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GmStreamEvent> {
    // 1. 保存用户消息到 gm_messages (mode='story' 剧情模式, 不存 chat_messages, 角色不可见)
    const userMsgId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: userMsgId,
      role: 'user',
      content: userContent,
      worldId,
      mode: 'story',
      createdAt: new Date().toISOString(),
    })

    // 2. 组装上下文: 剧情模式 system prompt + 世界规则 + 世界快照 + GM 历史
    //    只拉取 mode='story' 的历史, 隔离元对话 (GmPanel) 的消息
    const [history, rulesBlock, snapshot] = await Promise.all([
      db.query.gmMessages.findMany({
        where: and(
          eq(schema.gmMessages.worldId, worldId),
          eq(schema.gmMessages.mode, 'story'),
        ),
        orderBy: [desc(schema.gmMessages.createdAt)],
        limit: GM_HISTORY_LIMIT,
      }),
      getWorldRulesBlock(worldId),
      getWorldSnapshot(worldId),
    ])
    history.reverse()

    // 如果有活跃对话, 注入最近几条对话消息作为剧情上下文
    const recentChat = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
      orderBy: [desc(schema.messages.createdAt)],
      limit: 6,
    })
    recentChat.reverse()
    const chatContext =
      recentChat.length > 0
        ? recentChat
            .map((m) => {
              const speaker = m.speakerName ? `${m.speakerName}: ` : ''
              return `[${m.role}] ${speaker}${m.content.slice(0, 200)}`
            })
            .join('\n')
        : '(暂无对话历史)'

    const systemParts = [
      getPrompts().gmStory,
      `【当前对话场景】\n${chatContext}`,
    ]
    if (rulesBlock) systemParts.push(rulesBlock)
    systemParts.push(snapshot)

    const msgs: Array<Record<string, unknown>> = [
      { role: 'system', content: systemParts.join('\n\n') },
    ]
    for (const m of history) {
      if (m.id === userMsgId) {
        msgs.push({ role: 'user', content: m.content })
      } else {
        msgs.push({ role: m.role, content: m.content })
      }
    }

    // 3. 工具调用循环 (与元对话模式相同)
    let full = ''
    const outcomeRecords: Array<{
      skillName: string
      skillArgs: Record<string, unknown>
      codeResult: unknown
    }> = []
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        yield { type: 'thinking' }
        const { text, toolCalls } = await chatWithTools(msgs, skillDefs, {
          endpoint: resolveRole('gm'),
          temperature: 0.8,
          signal,
        })
        if (toolCalls.length === 0) {
          full = text
          break
        }
        msgs.push({
          role: 'assistant',
          content: text,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        })
        for (const tc of toolCalls) {
          const skillArgs = { ...tc.arguments, _worldId: worldId }
          const result = await executeSkill(tc.name, skillArgs)
          if (OUTCOME_SKILLS.has(tc.name)) {
            outcomeRecords.push({
              skillName: tc.name,
              skillArgs: tc.arguments,
              codeResult: result,
            })
          }
          msgs.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          })
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          full = text || '（工具调用达到上限，请简化请求）'
        }
      }

      // 4. 模拟流式
      const CHUNK = 12
      for (let i = 0; i < full.length; i += CHUNK) {
        yield { type: 'delta', text: full.slice(i, i + CHUNK) }
      }
    } catch (err) {
      const msg = err instanceof LlmError ? err.message : `gm chat failed: ${String(err)}`
      yield { type: 'error', message: msg }
      return
    }

    // 5. 保存 GM 回复到 chat_messages (narrator 角色) + gm_messages (mode='story')
    const narratorId = randomUUID()
    const gmMsgId = randomUUID()
    const now = new Date().toISOString()
    await db.insert(schema.messages).values({
      id: narratorId,
      conversationId,
      role: 'narrator',
      content: full,
      createdAt: now,
    })
    await db.insert(schema.gmMessages).values({
      id: gmMsgId,
      role: 'assistant',
      content: full,
      worldId,
      mode: 'story',
      createdAt: now,
    })
    for (const rec of outcomeRecords) {
      await db.insert(schema.gmOutcomes).values({
        id: randomUUID(),
        gmMessageId: gmMsgId,
        skillName: rec.skillName,
        skillArgs: rec.skillArgs,
        codeResult: rec.codeResult,
        gmNarrative: full,
        playerChoice: 'gm',
        createdAt: now,
      })
    }
    yield { type: 'done', messageId: narratorId }
  }
}

export const gmService = new GmService()
