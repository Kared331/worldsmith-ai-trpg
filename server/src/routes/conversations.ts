import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, desc, asc, and, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'

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
  const row = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, id) })
  res.status(201).json(row)
})

// 群聊成员列表 (含角色信息)
conversationsRouter.get('/:id/members', async (req, res) => {
  const members = await db.query.groupMembers.findMany({
    where: eq(schema.groupMembers.conversationId, req.params.id),
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
  const rows = await db.query.messages.findMany({
    where: eq(schema.messages.conversationId, req.params.id),
    orderBy: [asc(schema.messages.createdAt)],
  })
  res.json(rows)
})
