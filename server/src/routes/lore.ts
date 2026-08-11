import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'

const loreCreateSchema = z.object({
  keys: z.array(z.string().min(1).max(100)).min(1).max(50),
  content: z.string().min(1).max(20000),
  priority: z.number().int().min(0).max(10).default(1),
  enabled: z.boolean().default(true),
})

const loreUpdateSchema = loreCreateSchema.partial()

export const loreRouter = Router()

// 列表 (优先级降序, 仅当前世界)
loreRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const rows = await db.query.loreEntries.findMany({
    where: eq(schema.loreEntries.worldId, worldId),
    orderBy: [desc(schema.loreEntries.priority), desc(schema.loreEntries.updatedAt)],
  })
  res.json(rows)
})

// 创建
loreRouter.post('/', async (req, res) => {
  const parsed = loreCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const now = new Date().toISOString()
  await db.insert(schema.loreEntries).values({
    id: randomUUID(),
    ...parsed.data,
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  res.status(201).json(parsed.data)
})

// 更新
loreRouter.put('/:id', async (req, res) => {
  const parsed = loreUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await db.query.loreEntries.findFirst({
    where: eq(schema.loreEntries.id, req.params.id),
  })
  if (!existing) {
    res.status(404).json({ error: 'lore entry not found' })
    return
  }
  await db
    .update(schema.loreEntries)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(schema.loreEntries.id, req.params.id))
  const row = await db.query.loreEntries.findFirst({
    where: eq(schema.loreEntries.id, req.params.id),
  })
  res.json(row)
})

// 删除
loreRouter.delete('/:id', async (req, res) => {
  const result = await db
    .delete(schema.loreEntries)
    .where(eq(schema.loreEntries.id, req.params.id))
  if (result.changes === 0) {
    res.status(404).json({ error: 'lore entry not found' })
    return
  }
  res.status(204).end()
})
