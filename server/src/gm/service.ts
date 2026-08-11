import { randomUUID } from 'node:crypto'
import { eq, desc, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { streamChat, LlmError, chatWithTools, type ChatMsg } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'
import { skillDefs, executeSkill } from '../skills/index.js'
import { getWorldRulesBlock } from '../chat/context.js'
import type { Conversation } from '../db/schema.js'

// ============================================================
// GMService: Game Master 元对话 — 独立于角色扮演叙事流
// 唤醒方式: GM 面板输入 / 主对话框 /gm 前缀 / 关键事件(Phase2)
// ============================================================

const GM_HISTORY_LIMIT = 30

const GM_SYSTEM_PROMPT = [
  '你是 worldsmith 的 Game Master，一个世界叙事与规则引擎的管理者。',
  '你的职责：',
  '1. 回答玩家关于游戏世界、规则、剧情走向的元问题',
  '2. 主动创建和修改世界内容：角色、地图地点、连线、任务、玩家状态',
  '3. 裁决玩家与角色/系统之间的争议',
  '4. 解释世界状态与剧情脉络',
  '',
  '约束：',
  '- 不要扮演游戏内的角色，不要替角色说话',
  '- 直接、简洁、专业地回答，避免冗长套话',
  '- 涉及确定性数据（HP、位置、物品）时以系统状态为准',
  '- 玩家对游戏内容拥有最终编辑权，你只能建议不能强制',
  '',
  '你拥有的工具能力（通过 Skills 调用）：',
  '- roll_attack / roll_skill_check：战斗判定与属性检定',
  '- get_world_state：读取当前世界状态（角色/对话/任务摘要）',
  '- create_character：创建新角色（name/personality/background/appearance/firstMessage/scenario）',
  '- update_character：修改已有角色属性（按角色名定位）',
  '- create_location：创建地图地点（可指定 x/y 坐标，不传则自动散布）',
  '- update_location：修改地点的名称/描述/类型/坐标',
  '- create_connection：在两个地点之间创建道路连线（按地点名）',
  '- create_quest / get_quests：创建和查看任务',
  '- update_player_state：管理玩家状态栏（HP/位置/时间/物品/金币等，可增删改）',
  '- create_world_rule / update_world_rule / delete_world_rule / get_world_rules：管理世界规则（魔法系统/战斗规则/世界禁忌等，会注入到所有对话）',
  '',
  '使用要点：',
  '- system prompt 末尾注入了【当前世界快照】和【世界规则】, 你必须以此为事实基准, 不得编造名单外的人物/地点, 不得违反世界规则',
  '- 需要更详细数据时调用对应 Skill (如 get_world_state), 不要自己编造数值',
  '- 剧情需要新地点时调用 create_location，可指定坐标控制布局',
  '- 剧情需要新 NPC 时调用 create_character',
  '- 玩家受伤/移动/获得物品时调用 update_player_state 更新状态栏',
  '- 当玩家明确某些世界设定约束 (如魔法系统、禁忌) 时, 调用 create_world_rule 固化为规则, 避免后续对话遗忘',
  '- 你可以就以上机制与玩家讨论设计',
].join('\n')

// ============================================================
// 剧情模式 system prompt: GM 作为"说书人"推动剧情
// 与元对话模式不同: 侧重叙事输出, 可安排角色台词
// ============================================================

const GM_STORY_SYSTEM_PROMPT = [
  '你是 worldsmith 的 Game Master，当前以"说书人"身份推动剧情。',
  '',
  '你的职责：',
  '1. 根据玩家指令推动剧情发展（时间流逝、环境变化、事件发生）',
  '2. 以旁白身份描述场景、氛围与事件，用生动的文学笔法',
  '3. 当剧情需要某个角色说话或行动时，用 【角色名】"台词" 格式输出',
  '4. 可以调用工具修改世界状态（更新玩家状态、创建地点/角色等）',
  '',
  '输出格式：',
  '- 旁白/环境描写：直接输出文本，用 *星号* 包裹动作描写',
  '- 角色台词：【角色名】"台词内容"',
  '- 可在同一次回复中混合旁白与多个角色台词，推动剧情发展',
  '- 台词后可跟 *动作描写* 补充角色状态',
  '',
  '约束：',
  '- 不要替玩家角色做决定或说话',
  '- 保持叙事连贯，尊重已有世界设定和角色人设',
  '- 涉及确定性数据（HP、位置、物品）时以系统状态为准',
  '- 角色台词中的角色名必须是世界快照中已存在的角色',
  '',
  '你拥有的工具能力（通过 Skills 调用）：',
  '- roll_attack / roll_skill_check：战斗判定与属性检定',
  '- get_world_state：读取当前世界状态（角色/对话/任务摘要）',
  '- create_character：创建新角色',
  '- update_character：修改已有角色属性',
  '- create_location：创建地图地点',
  '- update_location：修改地点信息',
  '- create_connection：在两个地点之间创建道路连线',
  '- create_quest / get_quests：创建和查看任务',
  '- update_player_state：管理玩家状态栏（HP/位置/时间/物品/金币等）',
  '- create_world_rule / update_world_rule / delete_world_rule / get_world_rules：管理世界规则',
  '',
  '使用要点：',
  '- system prompt 末尾注入了【当前世界快照】和【世界规则】, 你必须以此为事实基准',
  '- 剧情需要新地点或新 NPC 时调用对应 Skill 创建',
  '- 玩家受伤/移动/获得物品时调用 update_player_state 更新状态栏',
  '- 输出应当具有沉浸感，像小说叙事一样推动故事',
].join('\n')

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
  async *streamMessage(userContent: string, worldId: string): AsyncGenerator<GmStreamEvent> {
    // 1. 保存用户消息 (带世界隔离)
    const userMsgId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: userMsgId,
      role: 'user',
      content: userContent,
      worldId,
      createdAt: new Date().toISOString(),
    })

    // 2. 组装上下文: system (静态职责 + 世界规则 + 世界快照) + 最近历史
    //    规则与快照每次请求实时拉取, 确保 GM 决策基于最新世界状态
    const [history, rulesBlock, snapshot] = await Promise.all([
      db.query.gmMessages.findMany({
        where: eq(schema.gmMessages.worldId, worldId),
        orderBy: [desc(schema.gmMessages.createdAt)],
        limit: GM_HISTORY_LIMIT,
      }),
      getWorldRulesBlock(worldId),
      getWorldSnapshot(worldId),
    ])
    history.reverse()

    // 拼接 system prompt: 静态职责 + 世界规则 + 世界快照
    const systemParts = [GM_SYSTEM_PROMPT]
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

    // 4. 保存助手消息 + 结局记录
    const assistantId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: assistantId,
      role: 'assistant',
      content: full,
      worldId,
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
  ): AsyncGenerator<GmStreamEvent> {
    // 1. 保存用户消息到 gm_messages (不存 chat_messages, 角色不可见)
    const userMsgId = randomUUID()
    await db.insert(schema.gmMessages).values({
      id: userMsgId,
      role: 'user',
      content: userContent,
      worldId,
      createdAt: new Date().toISOString(),
    })

    // 2. 组装上下文: 剧情模式 system prompt + 世界规则 + 世界快照 + GM 历史
    const [history, rulesBlock, snapshot] = await Promise.all([
      db.query.gmMessages.findMany({
        where: eq(schema.gmMessages.worldId, worldId),
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
      GM_STORY_SYSTEM_PROMPT,
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

    // 5. 保存 GM 回复到 chat_messages (narrator 角色) + gm_messages
    const narratorId = randomUUID()
    const now = new Date().toISOString()
    await db.insert(schema.messages).values({
      id: narratorId,
      conversationId,
      role: 'narrator',
      content: full,
      createdAt: now,
    })
    await db.insert(schema.gmMessages).values({
      id: narratorId,
      role: 'assistant',
      content: full,
      worldId,
      createdAt: now,
    })
    for (const rec of outcomeRecords) {
      await db.insert(schema.gmOutcomes).values({
        id: randomUUID(),
        gmMessageId: narratorId,
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
