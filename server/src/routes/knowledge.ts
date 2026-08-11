import { Router } from 'express'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { createKnowledgeEntry, deleteKnowledgeEntry, searchKnowledge } from '../memory/service.js'

const knowledgeCreateSchema = z.object({
  scope: z.enum(['character', 'world', 'scene']),
  ownerId: z.string().min(1),
  timestamp: z.string().max(200).default(''),
  type: z.enum(['event', 'trait', 'relationship', 'lore', 'quest']),
  content: z.string().min(1).max(20000),
  tags: z.array(z.string().max(50)).max(50).optional(),
  importance: z.number().int().min(1).max(5).optional(),
})

const knowledgeSearchSchema = z.object({
  query: z.string().min(1).max(2000),
  ownerId: z.string().optional(),
  topK: z.number().int().min(1).max(20).optional(),
})

export const knowledgeRouter = Router()

// 列表 (可按 scope/ownerId 过滤)
knowledgeRouter.get('/', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined
  const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined
  const rows = await db.query.knowledgeEntries.findMany({
    where: (k, { and, eq: eqFn }) => {
      const conds = []
      if (scope) conds.push(eqFn(k.scope, scope))
      if (ownerId) conds.push(eqFn(k.ownerId, ownerId))
      return conds.length ? and(...conds) : undefined
    },
    orderBy: [desc(schema.knowledgeEntries.createdAt)],
  })
  res.json(rows)
})

// 创建 (自动向量化)
knowledgeRouter.post('/', async (req, res) => {
  const parsed = knowledgeCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const row = await createKnowledgeEntry(parsed.data)
  res.status(201).json(row)
})

// 语义检索
knowledgeRouter.post('/search', async (req, res) => {
  const parsed = knowledgeSearchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  try {
    const results = await searchKnowledge(parsed.data.query, {
      ownerId: parsed.data.ownerId,
      topK: parsed.data.topK ?? 5,
    })
    res.json(results)
  } catch (err) {
    res.status(500).json({
      error: `search failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

// 删除
knowledgeRouter.delete('/:id', async (req, res) => {
  const ok = await deleteKnowledgeEntry(req.params.id)
  if (!ok) {
    res.status(404).json({ error: 'knowledge entry not found' })
    return
  }
  res.status(204).end()
})
