import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, and, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { connectionExists, autoConnect } from '../lib/geo.js'
import { getWorldId } from '../lib/world-context.js'
import { scopedLocation } from '../lib/scope.js'

const locationCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(20000).default(''),
  type: z
    .enum(['town', 'forest', 'mountain', 'lake', 'dungeon', 'other'])
    .default('other'),
  x: z.number().default(0),
  y: z.number().default(0),
  tags: z.array(z.string().max(50)).max(50).optional(),
})

const locationUpdateSchema = locationCreateSchema.partial()

export const locationsRouter = Router()

// 列表 (含连线, 仅当前世界)
locationsRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const locations = await db.query.locations.findMany({
    where: eq(schema.locations.worldId, worldId),
    orderBy: (l, { asc }) => [asc(l.createdAt)],
  })
  const locIds = locations.map((l) => l.id)
  const connections =
    locIds.length > 0
      ? await db.query.locationConnections.findMany({
          where: (c, { inArray }) => inArray(c.fromId, locIds),
        })
      : []
  res.json({ locations, connections })
})

// 创建 (自动连线到最近节点)
locationsRouter.post('/', async (req, res) => {
  const parsed = locationCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.insert(schema.locations).values({ id, ...parsed.data, worldId, createdAt: now, updatedAt: now })
  await autoConnect(id, parsed.data.x, parsed.data.y, worldId)
  const row = await db.query.locations.findFirst({ where: eq(schema.locations.id, id) })
  res.status(201).json(row)
})

// 详情
locationsRouter.get('/:id', async (req, res) => {
  const row = await scopedLocation(req.params.id, getWorldId(req))
  if (!row) {
    res.status(404).json({ error: 'location not found in current world' })
    return
  }
  res.json(row)
})

// 更新 (含拖拽后的 x/y 位置)
locationsRouter.put('/:id', async (req, res) => {
  const parsed = locationUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await scopedLocation(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'location not found in current world' })
    return
  }
  await db
    .update(schema.locations)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(schema.locations.id, req.params.id))
  const row = await db.query.locations.findFirst({
    where: eq(schema.locations.id, req.params.id),
  })
  res.json(row)
})

// 删除 (连线级联删除)
locationsRouter.delete('/:id', async (req, res) => {
  const existing = await scopedLocation(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'location not found in current world' })
    return
  }
  await db.delete(schema.locations).where(eq(schema.locations.id, req.params.id))
  res.status(204).end()
})

// 手动连线: 两端都必须属于当前世界 (否则会造出跨世界连线)
locationsRouter.post('/connections', async (req, res) => {
  const parsed = z
    .object({ fromId: z.string().min(1), toId: z.string().min(1) })
    .safeParse(req.body)
  if (!parsed.success || parsed.data.fromId === parsed.data.toId) {
    res.status(400).json({ error: 'invalid connection' })
    return
  }
  const worldId = getWorldId(req)
  const [from, to] = await Promise.all([
    scopedLocation(parsed.data.fromId, worldId),
    scopedLocation(parsed.data.toId, worldId),
  ])
  if (!from || !to) {
    res.status(404).json({ error: 'location not found in current world' })
    return
  }
  if (await connectionExists(parsed.data.fromId, parsed.data.toId)) {
    res.status(200).json({ ok: true, existed: true })
    return
  }
  await db.insert(schema.locationConnections).values({
    id: randomUUID(),
    fromId: parsed.data.fromId,
    toId: parsed.data.toId,
  })
  res.status(201).json({ ok: true })
})

// 删除连线 (两端都必须在当前世界)
locationsRouter.delete('/connections/:from/:to', async (req, res) => {
  const { from, to } = req.params
  const worldId = getWorldId(req)
  const [a, b] = await Promise.all([
    scopedLocation(from, worldId),
    scopedLocation(to, worldId),
  ])
  if (!a || !b) {
    res.status(404).json({ error: 'location not found in current world' })
    return
  }
  await db
    .delete(schema.locationConnections)
    .where(
      or(
        and(eq(schema.locationConnections.fromId, from), eq(schema.locationConnections.toId, to)),
        and(eq(schema.locationConnections.fromId, to), eq(schema.locationConnections.toId, from)),
      ),
    )
  res.status(204).end()
})
