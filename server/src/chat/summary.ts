import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { chat } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'

// ============================================================
// 滚动剧情摘要 (分层记忆的第一层)
//
// 背景: 上下文只保留最近 20 条 / 12000 字符, 更早的对话会被丢弃。
// 这里把最早的未摘要消息压缩成一段"前情提要"存进 conversations.summary,
// 长战役因此不会失忆, 同时不会像全文回放那样吃满 token。
// ============================================================

/** 未摘要消息达到该条数时压缩一批 (同时是每批的条数) */
const SUMMARY_BATCH = 20
/** 摘要入库前的长度上限 (字符) */
const SUMMARY_MAX_CHARS = 1200
/** 已有摘要参与合并时的长度上限 (字符) */
const PREV_SUMMARY_MAX_CHARS = 2000

/** 同一对话不允许并发的摘要任务 */
const running = new Set<string>()

function speakerLabel(m: { role: string; speakerName?: string | null }): string {
  if (m.role === 'user') return '玩家'
  if (m.role === 'narrator') return '旁白'
  return m.speakerName ?? '角色'
}

/**
 * 若存在足量未摘要消息, 把最早一批压进 conversations.summary 并推进游标。
 * 后台调用, 任何异常都不应影响主对话流。
 */
export async function maybeSummarize(conversationId: string): Promise<void> {
  if (running.has(conversationId)) return
  running.add(conversationId)
  try {
    const convo = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    })
    if (!convo) return

    // 全量升序取出后按游标切片: 比时间戳比较更可靠
    // (同一毫秒落库的消息用 createdAt > cursor 会被漏掉)
    const all = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
      orderBy: [asc(schema.messages.createdAt)],
    })
    const cursorIdx = convo.summaryThrough
      ? all.findIndex((m) => m.id === convo.summaryThrough)
      : -1
    // 游标消息已被删除时 findIndex 返回 -1, 从头开始是安全回退
    const pending = all.slice(cursorIdx + 1)
    if (pending.length < SUMMARY_BATCH) return

    const batch = pending.slice(0, SUMMARY_BATCH)
    const transcript = batch
      .map((m) => `${speakerLabel(m)}: ${m.content}`)
      .join('\n')

    let resp = ''
    try {
      resp = await chat(
        [
          {
            role: 'system',
            content: [
              '你是剧情摘要器。把「已有前情」与「新增对话」合并成一段紧凑的前情提要。',
              '只保留对后续剧情有影响的事实：人物关系变化、承诺与约定、关键事件、当前位置、重要物品、未解悬念。',
              '不要写文学化描写，不要评价，用第三人称，控制在 300 字以内。',
              '只输出摘要正文，不要加任何前缀或标题。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `【已有前情】\n${(convo.summary || '(无)').slice(0, PREV_SUMMARY_MAX_CHARS)}\n\n【新增对话】\n${transcript}`,
          },
        ],
        { endpoint: resolveRole('compressor'), temperature: 0.3, maxTokens: 800 },
      )
    } catch (err) {
      console.warn(
        `[summary] LLM 调用失败: ${err instanceof Error ? err.message : err}`,
      )
      return
    }

    const summary = resp.trim().slice(0, SUMMARY_MAX_CHARS)
    if (!summary) return

    await db
      .update(schema.conversations)
      .set({ summary, summaryThrough: batch[batch.length - 1].id })
      .where(eq(schema.conversations.id, conversationId))

    console.log(`[summary] ${conversationId}: 已压缩 ${batch.length} 条消息`)
  } catch (err) {
    console.warn(`[summary] 摘要任务失败: ${err instanceof Error ? err.message : err}`)
  } finally {
    running.delete(conversationId)
  }
}
