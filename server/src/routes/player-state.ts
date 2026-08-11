import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'

const stateUpsertSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(2000).default(''),
  label: z.string().max(50).optional(),
  icon: z.string().max(50).optional(),
})

export const playerStateRouter = Router()

// 列表 (仅当前世界)
playerStateRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const rows = await db.query.playerStates.findMany({
    where: eq(schema.playerStates.worldId, worldId),
    orderBy: (s, { asc }) => [asc(s.createdAt)],
  })
  res.json(rows)
})

// 新增或更新 (按 key + worldId upsert)
playerStateRouter.put('/', async (req, res) => {
  const parsed = stateUpsertSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const existing = await db.query.playerStates.findFirst({
    where: and(eq(schema.playerStates.key, parsed.data.key), eq(schema.playerStates.worldId, worldId)),
  })
  const now = new Date().toISOString()
  if (existing) {
    const updates = { value: parsed.data.value, updatedAt: now }
    if (parsed.data.label) (updates as Record<string, unknown>).label = parsed.data.label
    if (parsed.data.icon) (updates as Record<string, unknown>).icon = parsed.data.icon
    await db.update(schema.playerStates).set(updates).where(eq(schema.playerStates.id, existing.id))
    const row = await db.query.playerStates.findFirst({ where: eq(schema.playerStates.id, existing.id) })
    res.json(row)
    return
  }
  const id = randomUUID()
  await db.insert(schema.playerStates).values({
    id,
    key: parsed.data.key,
    value: parsed.data.value,
    label: parsed.data.label ?? parsed.data.key,
    icon: parsed.data.icon ?? 'Activity',
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.playerStates.findFirst({ where: eq(schema.playerStates.id, id) })
  res.status(201).json(row)
})

// 删除 (按 key + worldId)
playerStateRouter.delete('/:key', async (req, res) => {
  const worldId = getWorldId(req)
  const result = await db
    .delete(schema.playerStates)
    .where(and(eq(schema.playerStates.key, req.params.key), eq(schema.playerStates.worldId, worldId)))
  if (result.changes === 0) {
    res.status(404).json({ error: 'state not found' })
    return
  }
  res.status(204).end()
})
