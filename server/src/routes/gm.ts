import { Router } from 'express'
import { z } from 'zod'
import { asc, eq, and, inArray } from 'drizzle-orm'

import { db, schema } from '../db/index.js'
import { gmService } from '../gm/service.js'
import { getWorldId } from '../lib/world-context.js'
import { scopedGmOutcome } from '../lib/scope.js'

const gmChatSchema = z.object({
  content: z.string().min(1).max(20000),
  conversationId: z.string().min(1).optional(),
})

const outcomeUpdateSchema = z.object({
  choice: z.enum(['gm', 'code', 'custom']),
  customText: z.string().max(4000).optional(),
})

export const gmRouter = Router()

// GM 对话历史 (按世界隔离, 按 mode 过滤)
// 默认只返回 mode='meta' (GmPanel 元对话), 传 ?mode=story 返回剧情模式历史, ?mode=all 返回全部
gmRouter.get('/messages', async (req, res) => {
  const worldId = getWorldId(req)
  const modeParam = typeof req.query.mode === 'string' ? req.query.mode : 'meta'
  const where =
    modeParam === 'all'
      ? eq(schema.gmMessages.worldId, worldId)
      : and(
          eq(schema.gmMessages.worldId, worldId),
          eq(schema.gmMessages.mode, modeParam as 'meta' | 'story'),
        )
  const rows = await db.query.gmMessages.findMany({
    where,
    orderBy: [asc(schema.gmMessages.createdAt)],
  })
  res.json(rows)
})

// 结局记录列表 (按世界隔离: 通过 gmMessages.worldId 过滤; 可再按 gmMessageId 缩小范围)
gmRouter.get('/outcomes', async (req, res) => {
  const worldId = getWorldId(req)
  const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined
  // 先取当前世界所有 GM 消息 id, 再过滤 outcomes (gmOutcomes 无 worldId 字段, 靠关联)
  const worldMessages = await db.query.gmMessages.findMany({
    where: eq(schema.gmMessages.worldId, worldId),
    columns: { id: true },
  })
  const worldMessageIds = worldMessages.map((m) => m.id)
  if (worldMessageIds.length === 0) {
    res.json([])
    return
  }
  const where = messageId
    ? and(
        eq(schema.gmOutcomes.gmMessageId, messageId),
        inArray(schema.gmOutcomes.gmMessageId, worldMessageIds),
      )
    : inArray(schema.gmOutcomes.gmMessageId, worldMessageIds)
  const rows = await db.query.gmOutcomes.findMany({
    where,
    orderBy: [asc(schema.gmOutcomes.createdAt)],
  })
  res.json(rows)
})

// 玩家选择结局: gm(采纳GM叙事) / code(采纳系统判定) / custom(自定义)
gmRouter.put('/outcomes/:id', async (req, res) => {
  const parsed = outcomeUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await scopedGmOutcome(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'outcome not found in current world' })
    return
  }
  await db
    .update(schema.gmOutcomes)
    .set({
      playerChoice: parsed.data.choice,
      playerCustom: parsed.data.customText ?? null,
    })
    .where(eq(schema.gmOutcomes.id, req.params.id))
  const row = await db.query.gmOutcomes.findFirst({
    where: eq(schema.gmOutcomes.id, req.params.id),
  })
  res.json(row)
})

// GM 对话 (SSE 流式)
gmRouter.post('/chat', async (req, res) => {
  const parsed = gmChatSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    const worldId = getWorldId(req)
    const { content, conversationId } = parsed.data
    // 有 conversationId → 剧情模式: GM 回复注入主对话框 (narrator 消息)
    // 无 conversationId → 元对话模式: GM 面板纯幕后操作
    const stream = conversationId
      ? gmService.streamToConversation(content, worldId, conversationId, abort.signal)
      : gmService.streamMessage(content, worldId, abort.signal)
    for await (const ev of stream) {
      if (res.writableEnded) break
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`)
    }
  } finally {
    res.end()
  }
})
