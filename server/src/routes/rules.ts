import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'

// ============================================================
// 世界规则 (World Rules) 路由
// 按世界隔离: 所有查询/写入都过滤 worldId
// GM agent 和玩家都可创建规则 (通过 author 字段区分)
// ============================================================

export const rulesRouter = Router()

const CATEGORIES = ['system', 'combat', 'magic', 'world', 'other'] as const

const ruleCreateSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(20000),
  category: z.enum(CATEGORIES).default('other'),
  author: z.enum(['gm', 'player']).default('player'),
  enabled: z.boolean().default(true),
})

const ruleUpdateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(20000).optional(),
  category: z.enum(CATEGORIES).optional(),
  enabled: z.boolean().optional(),
})

/** GET /api/rules — 列出当前世界的所有规则 */
rulesRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const rows = await db.query.worldRules.findMany({
    where: eq(schema.worldRules.worldId, worldId),
    orderBy: [desc(schema.worldRules.createdAt)],
  })
  res.json(rows)
})

/** POST /api/rules — 创建规则 */
rulesRouter.post('/', async (req, res) => {
  const parsed = ruleCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const now = new Date().toISOString()
  const id = randomUUID()
  await db.insert(schema.worldRules).values({
    id,
    ...parsed.data,
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.worldRules.findFirst({ where: eq(schema.worldRules.id, id) })
  res.status(201).json(row)
})

/** PUT /api/rules/:id — 更新规则 (须属于当前世界) */
rulesRouter.put('/:id', async (req, res) => {
  const parsed = ruleUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const existing = await db.query.worldRules.findFirst({
    where: (r, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(r.id, req.params.id), eqFn(r.worldId, worldId)),
  })
  if (!existing) {
    res.status(404).json({ error: 'rule not found in current world' })
    return
  }
  await db
    .update(schema.worldRules)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(schema.worldRules.id, req.params.id))
  const row = await db.query.worldRules.findFirst({ where: eq(schema.worldRules.id, req.params.id) })
  res.json(row)
})

/** DELETE /api/rules/:id — 删除规则 (须属于当前世界) */
rulesRouter.delete('/:id', async (req, res) => {
  const worldId = getWorldId(req)
  const existing = await db.query.worldRules.findFirst({
    where: (r, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(r.id, req.params.id), eqFn(r.worldId, worldId)),
  })
  if (!existing) {
    res.status(404).json({ error: 'rule not found in current world' })
    return
  }
  await db.delete(schema.worldRules).where(eq(schema.worldRules.id, req.params.id))
  res.status(204).end()
})
