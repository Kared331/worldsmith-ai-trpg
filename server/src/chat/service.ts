import { randomUUID } from 'node:crypto'
import { eq, desc, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  assembleContext,
  parseGroupSpeaker,
  invalidateCharacterBlock,
  loadGroupCharacters,
} from './context.js'
import { detectOoc } from './ooc.js'
import { matchLore, truncateLore, renderLore } from './lore.js'
import { maybeExtractMemories } from '../memory/extractor.js'
import { getRecentMemories } from '../memory/service.js'
import { maybeSummarize } from './summary.js'
import { streamChat, LlmError, type ChatMsg } from '../llm/client.js'
import { executeSkill } from '../skills/index.js'

// ============================================================
// ChatService: 消息编排 — 保存用户消息 → 组装上下文 → 流式调用
//              → OOC 检测 → 保存助手消息
// 上下文组装逻辑 (chat/adventure/group 三模式) 见 context.ts
// GM 自动介入: 检测战斗/检定关键词 → 自动掷骰 → 注入判定结果
// ============================================================

/** 历史消息条数硬上限 */
const HISTORY_LIMIT = 20
/** 历史消息字符预算 (超出后丢弃更早的消息, 至少保留 4 条) */
const HISTORY_CHAR_BUDGET = 12000

function trimHistory<T extends { content: string }>(history: T[], budget: number): T[] {
  const minKeep = 4
  let used = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    const len = history[i].content.length
    if (history.length - start >= minKeep && used + len > budget) break
    used += len
    start = i
  }
  return history.slice(start)
}

// ============================================================
// GM 自动介入: 检测用户消息中的战斗/检定意图, 自动执行 skill 判定
// 判定结果注入上下文 (让角色 LLM 据此叙事) + 保存为 narrator 消息
// ============================================================

interface InterventionPlan {
  skill: string
  args: Record<string, unknown>
}

/** 检测用户消息是否触发 GM 自动介入 (保守匹配, 避免误触发) */
function detectGmIntervention(content: string): InterventionPlan | null {
  // 攻击类: 攻击动词 + 敌对目标
  const attackVerbs = /(攻击|挥剑|挥刀|射击|射箭|斩|砍|刺|劈|偷袭|施法|释放法术)/
  const targets = /(敌人|怪物|巨龙|哥布林|盗贼|兽人|骷髅|骑士|恶魔|巨魔|野狼|灰熊|毒蛇|蜘蛛|史莱姆|蝙蝠|食尸鬼)/
  if (attackVerbs.test(content) && targets.test(content)) {
    return {
      skill: 'roll_attack',
      args: { attacker: '玩家', attackBonus: 5, defense: 12, damageDice: '1d6' },
    }
  }
  // 检定类: 关键词 → stat 映射
  const checkMap: Array<{ keywords: RegExp; stat: string }> = [
    { keywords: /(感知|察觉|洞察|倾听|侦查)/, stat: '感知' },
    { keywords: /(隐匿|潜行|躲藏)/, stat: '敏捷' },
    { keywords: /(攀爬|游泳|举重|力量检定)/, stat: '力量' },
    { keywords: /(说服|威吓|交涉|魅力检定)/, stat: '魅力' },
    { keywords: /(调查|搜索|知识|智力检定)/, stat: '智力' },
    { keywords: /(体质|耐力|抗性|体质检定)/, stat: '体质' },
  ]
  for (const { keywords, stat } of checkMap) {
    if (keywords.test(content)) {
      return {
        skill: 'roll_skill_check',
        args: { character: '玩家', stat, modifier: 2, difficulty: 10 },
      }
    }
  }
  // 通用掷骰
  if (/检定|掷骰|roll/i.test(content)) {
    return {
      skill: 'roll_skill_check',
      args: { character: '玩家', stat: '综合', modifier: 2, difficulty: 10 },
    }
  }
  return null
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; ooc: string[]; speakerName?: string | null }
  | { type: 'error'; message: string }

export class ChatService {
  /**
   * @param userContent 新用户输入; 传 null 表示"重生成"——不插入新消息,
   *                    复用最后一条 user 消息作为本次生成的输入
   * @param signal 调用方中止信号 (客户端断开时路由层会 abort)
   */
  async *streamMessage(
    conversationId: string,
    userContent: string | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const convo = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    })
    if (!convo) throw new LlmError('conversation not found', 404)
    const character = await db.query.characters.findFirst({
      where: eq(schema.characters.id, convo.characterId),
    })
    if (!character) throw new LlmError('character not found', 404)

    // 1. 保存用户消息 (重生成时复用最后一条, 不重复落库)
    let userMsgId: string
    let content: string
    if (userContent === null) {
      const lastUser = await db.query.messages.findFirst({
        where: and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.role, 'user'),
        ),
        orderBy: [desc(schema.messages.createdAt)],
      })
      if (!lastUser) throw new LlmError('no user message to regenerate from', 400)
      userMsgId = lastUser.id
      content = lastUser.content
    } else {
      userMsgId = randomUUID()
      content = userContent
      await db.insert(schema.messages).values({
        id: userMsgId,
        conversationId,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      })
    }

    // 2. 加载历史消息 (含刚保存的用户消息), 按字符预算裁剪
    const recent = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
      orderBy: [desc(schema.messages.createdAt)],
      limit: HISTORY_LIMIT,
    })
    recent.reverse()
    const history = trimHistory(recent, HISTORY_CHAR_BUDGET)

    // 3. 按对话模式组装上下文 (group/adventure/chat 各自独立)
    const { msgs } = await assembleContext(
      convo,
      character,
      userMsgId,
      history,
    )

    // 3.1 前情提要: 被摘要压缩的早期剧情 (长战役的长期记忆底座)
    if (convo.summary && msgs[0]?.role === 'system') {
      msgs[0] = {
        role: 'system',
        content: msgs[0].content + `\n\n【前情提要】\n${convo.summary}`,
      }
    }

    // 4. Lorebook 关键词注入 (优先级排序 + 预算截断, 按世界隔离)
    await this.injectLore(msgs, content, character, history, convo.worldId)

    // 4.1 长期记忆注入: 角色记忆 + 世界记忆 (按重要度取最近 N 条)
    //     群聊只注入在场成员的私人记忆, 不在场角色的记忆不会串进来
    const memoryMembers =
      convo.mode === 'group' ? await loadGroupCharacters(conversationId) : [character]
    await this.injectMemories(msgs, memoryMembers, convo.worldId)

    // 5. GM 自动介入: 检测战斗/检定关键词 → 自动掷骰 → 注入判定结果
    const intervention = detectGmIntervention(content)
    if (intervention) {
      try {
        const skillArgs = { ...intervention.args, _worldId: convo.worldId }
        const result = (await executeSkill(intervention.skill, skillArgs)) as {
          summary?: string
        }
        const summary = result.summary ?? JSON.stringify(result)
        // 保存为 narrator 消息 (前端显示为 GM 叙事卡片)
        await db.insert(schema.messages).values({
          id: randomUUID(),
          conversationId,
          role: 'narrator',
          content: `【GM 自动判定】${summary}`,
          createdAt: new Date().toISOString(),
        })
        // 注入到上下文: 让角色 LLM 根据判定结果继续叙事
        msgs.push({
          role: 'system',
          content: `【系统判定结果】${summary}\n请根据此判定结果继续叙事，自然融入战斗或检定的后果。`,
        })
      } catch {
        // 自动介入失败不影响主对话流
      }
    }

    // 6. 流式调用 LLM
    let full = ''
    try {
      for await (const chunk of streamChat(msgs, { signal })) {
        full += chunk
        yield { type: 'delta', text: chunk }
      }
    } catch (err) {
      const msg =
        err instanceof LlmError ? err.message : `chat failed: ${String(err)}`
      yield { type: 'error', message: msg }
      return
    }

    // 6. OOC 检测 + speaker 解析 (群聊) + 保存助手消息
    const report = detectOoc(full)
    let speakerName: string | null = null
    let finalContent = report.clean
    if (convo.mode === 'group') {
      const parsed = await parseGroupSpeaker(conversationId, finalContent)
      speakerName = parsed.speakerName
      finalContent = parsed.content
    }

    const assistantId = randomUUID()
    await db.insert(schema.messages).values({
      id: assistantId,
      conversationId,
      role: convo.mode === 'adventure' ? 'narrator' : 'assistant',
      content: finalContent,
      speakerName,
      createdAt: new Date().toISOString(),
    })

    yield { type: 'done', messageId: assistantId, ooc: report.matched, speakerName }

    // 7. 后台记忆提取 + 剧情摘要 (均不阻塞响应)
    maybeExtractMemories(conversationId).catch(() => {})
    maybeSummarize(conversationId).catch(() => {})
  }

  /** Lorebook 关键词注入: 扫描文本 → 匹配 → 截断 → 追加到 system
   *  按 worldId 隔离, 且必须是"追加"而非"覆盖":
   *  msgs[0].content 已由 assembleContext 拼好【玩家身份】【世界规则】前缀 */
  private async injectLore(
    msgs: ChatMsg[],
    userContent: string,
    character: { background: string; personality: string },
    history: Array<{ content: string }>,
    worldId: string,
  ): Promise<void> {
    const scanTexts = [
      userContent,
      character.background,
      character.personality,
      ...history.slice(-6).map((m) => m.content),
    ]
    const matched = await matchLore(scanTexts, worldId)
    const lore = truncateLore(matched)
    if (lore.length > 0) {
      const base = msgs[0]?.content ?? ''
      msgs[0] = {
        role: 'system',
        content:
          base +
          `\n\n【世界知识】\n${renderLore(lore)}\n(以上为世界设定，角色可能知晓部分，按角色认知合理运用)`,
      }
    }
  }

  /** 角色变更后使角色块缓存失效 */
  invalidateCharacter(characterId: string): void {
    invalidateCharacterBlock(characterId)
  }

  /**
   * 长期记忆注入: 在场成员的角色记忆 + 世界记忆, 追加到 system prompt。
   * 固定注入"最重要 + 最近"的若干条, 并受字符预算约束;
   * 群聊时标注记忆归属, 避免 AI 把某角色的私人经历当成共识。
   */
  private async injectMemories(
    msgs: ChatMsg[],
    members: Array<{ id: string; name: string }>,
    worldId: string,
  ): Promise<void> {
    if (msgs[0]?.role !== 'system' || members.length === 0) return

    let memories
    try {
      memories = await getRecentMemories({
        characterIds: members.map((m) => m.id),
        worldId,
        limit: members.length > 1 ? 8 : 6,
      })
    } catch {
      return
    }
    if (memories.length === 0) return

    const nameById = new Map(members.map((m) => [m.id, m.name]))
    const showOwner = members.length > 1

    const lines: string[] = []
    let budget = 900
    for (const m of memories) {
      const owner =
        showOwner && m.scope === 'character' ? `[${nameById.get(m.ownerId) ?? '角色'}]` : ''
      const line = `- ${owner}[${m.type}] ${m.timestamp}: ${m.content.slice(0, 120)}`
      if (line.length > budget) break
      budget -= line.length
      lines.push(line)
    }
    if (lines.length === 0) return

    msgs[0] = {
      role: 'system',
      content:
        msgs[0].content +
        `\n\n【相关记忆】(理解前情用, 不要在回复中直接复述)\n${lines.join('\n')}`,
    }
  }
}

export const chatService = new ChatService()
