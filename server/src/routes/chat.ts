import { Router } from 'express'
import { z } from 'zod'
import { chatService } from '../chat/service.js'

const chatRequestSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1).max(20000),
})

export const chatRouter = Router()

/**
 * POST /api/chat
 * SSE 流式响应: data: {"type":"delta","text":"..."} / {"type":"done",...} / {"type":"error",...}
 * chatService 内部通过 conversation.worldId 实现世界隔离, 无需路由层传 worldId
 */
chatRouter.post('/', async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body)
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

  // 客户端断开时中止 LLM 请求
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    for await (const ev of chatService.streamMessage(
      parsed.data.conversationId,
      parsed.data.content,
    )) {
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
