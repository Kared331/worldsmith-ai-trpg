import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, desc, asc, and, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'
import { scopedConversation } from '../lib/scope.js'
import { chatService } from '../chat/service.js'

const conversationCreateSchema = z.object({
  characterId: z.string().min(1).optional(),
  /** 群聊: 多个角色 id */
  characterIds: z.array(z.string().min(1)).min(2).max(10).optional(),
  mode: z.enum(['chat', 'adventure', 'group']).default('chat'),
  title: z.string().max(200).optional().nullable(),
})

export const conversationsRouter = Router()

// 列表 (当前世界, 可按角色过滤)
conversationsRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined
  const rows = await db.query.conversations.findMany({
    where: characterId
      ? and(eq(schema.conversations.characterId, characterId), eq(schema.conversations.worldId, worldId))
      : eq(schema.conversations.worldId, worldId),
    orderBy: [desc(schema.conversations.createdAt)],
  })
  res.json(rows)
})

// 部分更新对话: 支持切换模式 (mode) 和重命名 (title)
// chat↔adventure: 直接改 mode
// →group: 需传 characterIds (≥2), 重建 group_members; characterId 取第一个
// group→其他: 删除 group_members, 保留原 characterId
// title: 单独传 title 时仅重命名, 不触发 mode 切换逻辑
const conversationPatchSchema = z.object({
  mode: z.enum(['chat', 'adventure', 'group']).optional(),
  /** 仅 mode=group 时需要: 群成员角色 id (≥2) */
  characterIds: z.array(z.string().min(1)).min(2).max(10).optional(),
  /** 重命名对话标题 (传 null 清空) */
  title: z.string().max(200).optional().nullable(),
})

conversationsRouter.patch('/:id', async (req, res) => {
  const parsed = conversationPatchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const { mode, characterIds, title } = parsed.data
  const worldId = getWorldId(req)
  const convId = req.params.id

  // 至少要传一个可更新字段
  if (mode === undefined && title === undefined) {
    res.status(400).json({ error: 'at least one of mode or title is required' })
    return
  }

  // 1. 校验对话存在且属于当前世界
  const existing = await db.query.conversations.findFirst({
    where: (c, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(c.id, convId), eqFn(c.worldId, worldId)),
  })
  if (!existing) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }

  // 2. 处理模式切换 (仅传 mode 时执行)
  let newCharacterId = existing.characterId
  let newTitle = existing.title
  const patch: Record<string, unknown> = {}

  if (mode !== undefined) {
    if (mode === 'group') {
      if (!characterIds || characterIds.length < 2) {
        res.status(400).json({ error: '切换到群聊需要至少 2 个角色 (characterIds)' })
        return
      }
      const found = await db.query.characters.findMany({
        where: (c, { and: andFn, inArray }) =>
          andFn(inArray(c.id, characterIds), eq(c.worldId, worldId)),
      })
      if (found.length !== characterIds.length) {
        res.status(404).json({ error: 'one or more characters not found in current world' })
        return
      }
      newCharacterId = characterIds[0]
      newTitle = found.map((c) => c.name).join('、')
      // 删除旧成员, 插入新成员
      await db.delete(schema.groupMembers).where(eq(schema.groupMembers.conversationId, convId))
      await db.insert(schema.groupMembers).values(
        characterIds.map((cid, i) => ({
          id: randomUUID(),
          conversationId: convId,
          characterId: cid,
          joinOrder: i,
        })),
      )
    } else if (existing.mode === 'group') {
      // group → chat/adventure: 删除 group_members, 标题清空
      await db.delete(schema.groupMembers).where(eq(schema.groupMembers.conversationId, convId))
      newTitle = null
    }
    patch.mode = mode
    patch.characterId = newCharacterId
    // mode 切换会覆盖 title (除非显式传 title)
    patch.title = title !== undefined ? title : newTitle
  }

  // 3. 单独重命名 (未传 mode 时, title 单独更新)
  if (mode === undefined && title !== undefined) {
    patch.title = title
  }

  // 4. 更新对话
  await db
    .update(schema.conversations)
    .set(patch)
    .where(eq(schema.conversations.id, convId))

  const row = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, convId) })
  res.json(row)
})

// 删除对话 (级联删除消息和群成员)
conversationsRouter.delete('/:id', async (req, res) => {
  const worldId = getWorldId(req)
  const convId = req.params.id

  // 校验对话存在且属于当前世界 (防止跨世界删除)
  const existing = await db.query.conversations.findFirst({
    where: (c, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(c.id, convId), eqFn(c.worldId, worldId)),
  })
  if (!existing) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }

  // 删除对话 (messages 和 group_members 通过 onDelete: cascade 自动级联)
  await db.delete(schema.conversations).where(eq(schema.conversations.id, convId))
  res.status(204).end()
})

// 创建 (chat/adventure: characterId; group: characterIds)
conversationsRouter.post('/', async (req, res) => {
  const parsed = conversationCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const { characterId, characterIds, mode, title } = parsed.data
  const worldId = getWorldId(req)

  // 校验角色存在且属于当前世界
  const ids = mode === 'group' ? (characterIds ?? []) : [characterId ?? '']
  if (ids.length === 0 || ids.some((i) => !i)) {
    res.status(400).json({ error: 'characterId or characterIds required' })
    return
  }
  const found = await db.query.characters.findMany({
    where: (c, { and, inArray }) =>
      and(inArray(c.id, ids), eq(c.worldId, worldId)),
  })
  if (found.length !== ids.length) {
    res.status(404).json({ error: 'one or more characters not found in current world' })
    return
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  await db.insert(schema.conversations).values({
    id,
    characterId: mode === 'group' ? ids[0] : ids[0],
    mode,
    title: title ?? (mode === 'group' ? found.map((c) => c.name).join('、') : undefined),
    worldId,
    createdAt: now,
  })
  if (mode === 'group') {
    await db.insert(schema.groupMembers).values(
      ids.map((cid, i) => ({
        id: randomUUID(),
        conversationId: id,
        characterId: cid,
        joinOrder: i,
      })),
    )
  }

  // ---------- 开场白注入 (RPG 仪式感) ----------
  // chat: 角色先开口 (firstMessage); adventure: GM 开场叙事; group: GM 介绍场景
  const openingTime = new Date().toISOString()
  if (mode === 'chat') {
    const char = found[0]
    if (char.firstMessage) {
      await db.insert(schema.messages).values({
        id: randomUUID(),
        conversationId: id,
        role: 'assistant',
        content: char.firstMessage,
        speakerName: char.name,
        createdAt: openingTime,
      })
    }
  } else if (mode === 'adventure') {
    const char = found[0]
    const scene =
      char.scenario ||
      `*你踏入了一段全新的冒险旅程。前方是未知的世界，而你——${char.name}——已准备好迎接一切。*\n\n*告诉我，你的故事从何处开始？*`
    await db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId: id,
      role: 'narrator',
      content: scene,
      createdAt: openingTime,
    })
  } else if (mode === 'group') {
    const names = found.map((c) => c.name).join('、')
    await db.insert(schema.messages).values({
      id: randomUUID(),
      conversationId: id,
      role: 'narrator',
      content: `*${names} 聚在了同一处。命运的齿轮开始转动——*\n\n*故事，即将展开。*`,
      createdAt: openingTime,
    })
  }

  const row = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, id) })
  res.status(201).json(row)
})

// 群聊成员列表 (含角色信息)
conversationsRouter.get('/:id/members', async (req, res) => {
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }
  const members = await db.query.groupMembers.findMany({
    where: eq(schema.groupMembers.conversationId, conv.id),
    orderBy: [asc(schema.groupMembers.joinOrder)],
  })
  const characters = await db.query.characters.findMany({
    where: (c, { inArray }) => inArray(
      c.id,
      members.map((m) => m.characterId),
    ),
  })
  res.json(
    members.map((m) => ({
      ...m,
      character: characters.find((c) => c.id === m.characterId) ?? null,
    })),
  )
})

// 消息列表
conversationsRouter.get('/:id/messages', async (req, res) => {
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }
  const rows = await db.query.messages.findMany({
    where: eq(schema.messages.conversationId, conv.id),
    orderBy: [asc(schema.messages.createdAt)],
  })
  res.json(rows)
})

// 编辑单条消息
conversationsRouter.patch('/:id/messages/:messageId', async (req, res) => {
  const parsed = z.object({ content: z.string().min(1).max(20000) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }
  const row = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.id, req.params.messageId),
      eq(schema.messages.conversationId, conv.id),
    ),
  })
  if (!row) {
    res.status(404).json({ error: 'message not found' })
    return
  }
  await db
    .update(schema.messages)
    .set({ content: parsed.data.content })
    .where(eq(schema.messages.id, row.id))
  res.json({ ...row, content: parsed.data.content })
})

// 删除单条消息
conversationsRouter.delete('/:id/messages/:messageId', async (req, res) => {
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }
  const row = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.id, req.params.messageId),
      eq(schema.messages.conversationId, conv.id),
    ),
  })
  if (!row) {
    res.status(404).json({ error: 'message not found' })
    return
  }
  await db.delete(schema.messages).where(eq(schema.messages.id, row.id))
  res.json({ ok: true })
})

/**
 * 从指定消息处分叉: 复制该消息及其之前的全部消息到新对话。
 * 用于"这一步不满意, 想从更早的地方重来"的场景, 原对话保持不变。
 */
conversationsRouter.post('/:id/fork', async (req, res) => {
  const parsed = z.object({ messageId: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'messageId required' })
    return
  }
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }

  const all = await db.query.messages.findMany({
    where: eq(schema.messages.conversationId, conv.id),
    orderBy: [asc(schema.messages.createdAt)],
  })
  const idx = all.findIndex((m) => m.id === parsed.data.messageId)
  if (idx === -1) {
    res.status(404).json({ error: 'message not found' })
    return
  }
  const kept = all.slice(0, idx + 1)

  const newId = randomUUID()
  const now = new Date().toISOString()
  await db.insert(schema.conversations).values({
    id: newId,
    characterId: conv.characterId,
    mode: conv.mode,
    title: conv.title ? `${conv.title} · 分支` : '分支对话',
    worldId: conv.worldId,
    createdAt: now,
  })

  // 群聊需要一并复制成员, 否则新对话没有 speaker 名单
  if (conv.mode === 'group') {
    const members = await db.query.groupMembers.findMany({
      where: eq(schema.groupMembers.conversationId, conv.id),
    })
    if (members.length > 0) {
      await db.insert(schema.groupMembers).values(
        members.map((m) => ({
          id: randomUUID(),
          conversationId: newId,
          characterId: m.characterId,
          joinOrder: m.joinOrder,
        })),
      )
    }
  }

  await db.insert(schema.messages).values(
    kept.map((m) => ({
      id: randomUUID(),
      conversationId: newId,
      role: m.role,
      content: m.content,
      speakerName: m.speakerName,
      createdAt: m.createdAt,
    })),
  )

  const row = await db.query.conversations.findFirst({
    where: eq(schema.conversations.id, newId),
  })
  res.status(201).json(row)
})

/**
 * 重新生成最后一条 AI 回复
 * 末尾是 assistant/narrator 时先删除再重跑; 末尾是用户消息则直接生成
 * SSE 响应格式与 POST /api/chat 一致
 */
conversationsRouter.post('/:id/regenerate', async (req, res) => {
  const conv = await scopedConversation(req.params.id, getWorldId(req))
  if (!conv) {
    res.status(404).json({ error: 'conversation not found in current world' })
    return
  }

  const last = await db.query.messages.findFirst({
    where: eq(schema.messages.conversationId, conv.id),
    orderBy: [desc(schema.messages.createdAt)],
  })
  if (!last) {
    res.status(400).json({ error: 'conversation has no messages' })
    return
  }
  // 先确认有可复用的用户消息, 再删旧回复: 否则删完才发现无从生成, 旧内容就丢了
  const lastUser = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.conversationId, conv.id),
      eq(schema.messages.role, 'user'),
    ),
    orderBy: [desc(schema.messages.createdAt)],
  })
  if (!lastUser) {
    res.status(400).json({ error: 'no user message to regenerate from' })
    return
  }
  if (last.role === 'assistant' || last.role === 'narrator') {
    await db.delete(schema.messages).where(eq(schema.messages.id, last.id))
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
    for await (const ev of chatService.streamMessage(conv.id, null, abort.signal)) {
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
