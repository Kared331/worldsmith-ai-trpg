import { randomUUID } from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  assembleContext,
  parseGroupSpeaker,
  invalidateCharacterBlock,
} from './context.js'
import { detectOoc } from './ooc.js'
import { matchLore, truncateLore, renderLore } from './lore.js'
import { maybeExtractMemories } from '../memory/extractor.js'
import { streamChat, LlmError, type ChatMsg } from '../llm/client.js'
import { executeSkill } from '../skills/index.js'

// ============================================================
// ChatService: 消息编排 — 保存用户消息 → 组装上下文 → 流式调用
//              → OOC 检测 → 保存助手消息
// 上下文组装逻辑 (chat/adventure/group 三模式) 见 context.ts
// GM 自动介入: 检测战斗/检定关键词 → 自动掷骰 → 注入判定结果
// ============================================================

/** 最近保留的完整消息条数 (更早的由压缩层处理, Phase 4) */
const HISTORY_LIMIT = 20

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
  async *streamMessage(
    conversationId: string,
    userContent: string,
  ): AsyncGenerator<StreamEvent> {
    const convo = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    })
    if (!convo) throw new LlmError('conversation not found', 404)
    const character = await db.query.characters.findFirst({
      where: eq(schema.characters.id, convo.characterId),
    })
    if (!character) throw new LlmError('character not found', 404)

    // 1. 保存用户消息
    const userMsgId = randomUUID()
    await db.insert(schema.messages).values({
      id: userMsgId,
      conversationId,
      role: 'user',
      content: userContent,
      createdAt: new Date().toISOString(),
    })

    // 2. 加载历史消息 (含刚保存的用户消息)
    const history = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
      orderBy: [desc(schema.messages.createdAt)],
      limit: HISTORY_LIMIT,
    })
    history.reverse()

    // 3. 按对话模式组装上下文 (group/adventure/chat 各自独立)
    const { system, msgs } = await assembleContext(
      convo,
      character,
      userMsgId,
      history,
    )

    // 4. Lorebook 关键词注入 (优先级排序 + 预算截断)
    await this.injectLore(system, msgs, userContent, character, history)

    // 5. GM 自动介入: 检测战斗/检定关键词 → 自动掷骰 → 注入判定结果
    const intervention = detectGmIntervention(userContent)
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
      for await (const chunk of streamChat(msgs)) {
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

    // 7. 后台记忆提取 (每 N 条消息, 不阻塞响应)
    maybeExtractMemories(conversationId).catch(() => {})
  }

  /** Lorebook 关键词注入: 扫描文本 → 匹配 → 截断 → 追加到 system */
  private async injectLore(
    system: string,
    msgs: ChatMsg[],
    userContent: string,
    character: { background: string; personality: string },
    history: Array<{ content: string }>,
  ): Promise<void> {
    const scanTexts = [
      userContent,
      character.background,
      character.personality,
      ...history.slice(-6).map((m) => m.content),
    ]
    const matched = await matchLore(scanTexts)
    const lore = truncateLore(matched)
    if (lore.length > 0) {
      const updated =
        system +
        `\n\n【世界知识】\n${renderLore(lore)}\n(以上为世界设定，角色可能知晓部分，按角色认知合理运用)`
      msgs[0] = { role: 'system', content: updated }
    }
  }

  /** 角色变更后使角色块缓存失效 */
  invalidateCharacter(characterId: string): void {
    invalidateCharacterBlock(characterId)
  }
}

export const chatService = new ChatService()
