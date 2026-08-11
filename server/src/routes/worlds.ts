import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, asc, isNull, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { WorldExport } from '@worldsmith/shared'
import { DEFAULT_WORLD_ID } from '../lib/world-context.js'

const worldCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
})

const worldUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
})

const worldDeleteSchema = z.object({
  /** 删除世界时是否保留角色到角色库 (worldId 设为 null) */
  keepCharacters: z.boolean().default(false),
  /** 删除世界时是否导出世界设定 */
  exportSettings: z.boolean().default(false),
})

export const worldsRouter = Router()

// 列表 (按 sortOrder 升序)
worldsRouter.get('/', async (_req, res) => {
  const rows = await db.query.worlds.findMany({
    orderBy: [asc(schema.worlds.sortOrder), asc(schema.worlds.createdAt)],
  })
  res.json(rows)
})

// 创建
worldsRouter.post('/', async (req, res) => {
  const parsed = worldCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  // 计算排序权重: 当前最大值 + 1
  const existing = await db.query.worlds.findMany({
    orderBy: [asc(schema.worlds.sortOrder)],
  })
  const maxSort = existing.length > 0 ? Math.max(...existing.map((w) => w.sortOrder)) : 0
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.insert(schema.worlds).values({
    id,
    name: parsed.data.name,
    description: parsed.data.description,
    sortOrder: maxSort + 1,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.worlds.findFirst({ where: eq(schema.worlds.id, id) })
  res.status(201).json(row)
})

// 改名 / 改描述
worldsRouter.put('/:id', async (req, res) => {
  const parsed = worldUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await db.query.worlds.findFirst({
    where: eq(schema.worlds.id, req.params.id),
  })
  if (!existing) {
    res.status(404).json({ error: 'world not found' })
    return
  }
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (parsed.data.name !== undefined) updates.name = parsed.data.name
  if (parsed.data.description !== undefined) updates.description = parsed.data.description
  await db.update(schema.worlds).set(updates).where(eq(schema.worlds.id, req.params.id))
  const row = await db.query.worlds.findFirst({ where: eq(schema.worlds.id, req.params.id) })
  res.json(row)
})

// 导出世界设定 (不删数据, 仅返回快照)
worldsRouter.get('/:id/export', async (req, res) => {
  const world = await db.query.worlds.findFirst({
    where: eq(schema.worlds.id, req.params.id),
  })
  if (!world) {
    res.status(404).json({ error: 'world not found' })
    return
  }
  const locations = await db.query.locations.findMany({
    where: eq(schema.locations.worldId, world.id),
    orderBy: [asc(schema.locations.createdAt)],
  })
  const locIds = locations.map((l) => l.id)
  const connections =
    locIds.length > 0
      ? await db.query.locationConnections.findMany({
          where: (c, { or, and, inArray }) =>
            or(
              and(inArray(c.fromId, locIds), inArray(c.toId, locIds)),
            ),
        })
      : []
  const loreEntries = await db.query.loreEntries.findMany({
    where: eq(schema.loreEntries.worldId, world.id),
  })
  const playerStates = await db.query.playerStates.findMany({
    where: eq(schema.playerStates.worldId, world.id),
  })
  const quests = await db.query.knowledgeEntries.findMany({
    where: (k, { and }) => and(eq(k.scope, 'world'), eq(k.ownerId, world.id), eq(k.type, 'quest')),
  })
  const exportData: WorldExport = {
    world: { name: world.name, description: world.description },
    // drizzle 推断 tags 为 string[] | null, 补默认值对齐 shared 类型
    locations: locations.map((l) => ({ ...l, tags: l.tags ?? [] })),
    connections,
    loreEntries,
    playerStates,
    quests: quests.map((q) => ({
      name: q.tags?.[0] ?? '未命名',
      location: q.tags?.[1] ?? '',
      description: q.content,
      importance: q.importance,
    })),
    exportedAt: new Date().toISOString(),
  }
  res.json(exportData)
})

// 删除世界 (可选择保留角色到角色库 / 导出世界设定)
worldsRouter.delete('/:id', async (req, res) => {
  const worldId = req.params.id
  if (worldId === DEFAULT_WORLD_ID) {
    res.status(400).json({ error: '默认世界不可删除' })
    return
  }
  const parsed = worldDeleteSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const { keepCharacters, exportSettings } = parsed.data

  const world = await db.query.worlds.findFirst({
    where: eq(schema.worlds.id, worldId),
  })
  if (!world) {
    res.status(404).json({ error: 'world not found' })
    return
  }

  // 1. 可选: 导出世界设定 (返回给前端, 前端自行下载)
  let exportData: WorldExport | null = null
  if (exportSettings) {
    const locations = await db.query.locations.findMany({
      where: eq(schema.locations.worldId, worldId),
    })
    const locIds = locations.map((l) => l.id)
    const connections =
      locIds.length > 0
        ? await db.query.locationConnections.findMany({
            where: (c, { inArray }) => inArray(c.fromId, locIds),
          })
        : []
    const loreEntries = await db.query.loreEntries.findMany({
      where: eq(schema.loreEntries.worldId, worldId),
    })
    const playerStates = await db.query.playerStates.findMany({
      where: eq(schema.playerStates.worldId, worldId),
    })
    const quests = await db.query.knowledgeEntries.findMany({
      where: (k, { and }) => and(eq(k.scope, 'world'), eq(k.ownerId, worldId), eq(k.type, 'quest')),
    })
    exportData = {
      world: { name: world.name, description: world.description },
      locations: locations.map((l) => ({ ...l, tags: l.tags ?? [] })),
      connections,
      loreEntries,
      playerStates,
      quests: quests.map((q) => ({
        name: q.tags?.[0] ?? '未命名',
        location: q.tags?.[1] ?? '',
        description: q.content,
        importance: q.importance,
      })),
      exportedAt: new Date().toISOString(),
    }
  }

  // 2. 可选: 保留角色到角色库 (worldId 设为 null)
  //    不保留的角色会随世界级联删除 (schema onDelete: 'set null' 不会级联删角色)
  //    但角色的对话/消息会随世界删除, 所以角色会变成"无对话的孤儿"
  //    实际上 characters.worldId 是 set null, 所以角色不会被删, 只是变成角色库
  //    需要手动把不保留的角色删掉
  if (!keepCharacters) {
    // 删除该世界所有角色 (conversations/messages 等会级联)
    await db.delete(schema.characters).where(eq(schema.characters.worldId, worldId))
  } else {
    // 保留角色: worldId 设为 null (放入角色库)
    await db
      .update(schema.characters)
      .set({ worldId: null })
      .where(eq(schema.characters.worldId, worldId))
  }

  // 3. 删除世界本身 (其余表通过 onDelete: cascade 级联删除)
  await db.delete(schema.worlds).where(eq(schema.worlds.id, worldId))

  res.json({
    deleted: true,
    worldId,
    worldName: world.name,
    keptCharacters: keepCharacters,
    exportData,
  })
})

// 角色库: 获取所有 worldId 为 null 的角色
worldsRouter.get('/library/characters', async (_req, res) => {
  const rows = await db.query.characters.findMany({
    where: isNull(schema.characters.worldId),
    orderBy: (c, { desc }) => [desc(c.updatedAt)],
  })
  res.json(rows)
})

// 角色库: 把角色从角色库导入到指定世界 (复制角色, 原角色保留在库中)
worldsRouter.post('/library/characters/:id/import', async (req, res) => {
  const sourceId = req.params.id
  const targetWorldId = typeof req.query.worldId === 'string' ? req.query.worldId : undefined
  if (!targetWorldId) {
    res.status(400).json({ error: 'worldId query param required' })
    return
  }
  const source = await db.query.characters.findFirst({
    where: eq(schema.characters.id, sourceId),
  })
  if (!source) {
    res.status(404).json({ error: 'character not found' })
    return
  }
  // 复制角色到目标世界
  const newId = randomUUID()
  const now = new Date().toISOString()
  await db.insert(schema.characters).values({
    id: newId,
    name: source.name,
    personality: source.personality,
    background: source.background,
    appearance: source.appearance,
    firstMessage: source.firstMessage,
    scenario: source.scenario,
    tags: source.tags,
    avatar: source.avatar,
    blocks: source.blocks,
    worldId: targetWorldId,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.characters.findFirst({ where: eq(schema.characters.id, newId) })
  res.status(201).json(row)
})

// 角色库: 把指定世界的角色移到角色库 (worldId 设为 null)
worldsRouter.post('/library/characters/:id/detach', async (req, res) => {
  const char = await db.query.characters.findFirst({
    where: eq(schema.characters.id, req.params.id),
  })
  if (!char) {
    res.status(404).json({ error: 'character not found' })
    return
  }
  await db
    .update(schema.characters)
    .set({ worldId: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.characters.id, req.params.id))
  const row = await db.query.characters.findFirst({ where: eq(schema.characters.id, req.params.id) })
  res.json(row)
})
