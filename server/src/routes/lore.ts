import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'
import { scopedLoreEntry } from '../lib/scope.js'

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
  const id = randomUUID()
  await db.insert(schema.loreEntries).values({
    id,
    ...parsed.data,
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  // 返回落库后的完整行 (含 id/worldId/时间戳), 与其他创建接口保持一致;
  // 此前直接回 parsed.data 会导致调用方拿不到新建条目的 id
  const row = await db.query.loreEntries.findFirst({
    where: eq(schema.loreEntries.id, id),
  })
  res.status(201).json(row)
})

/** SillyTavern World Info 条目的字段子集 */
interface WorldInfoEntry {
  key?: unknown
  keys?: unknown
  content?: unknown
  order?: unknown
  disable?: unknown
}

function parseKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.trim())
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * 导入 SillyTavern 世界书 (World Info) JSON
 * 兼容三种形态: { entries: { "0": {...} } } / { entries: [...] } / 纯数组
 * 字段映射: key→keys, order→priority(归一化到 0-10), disable→enabled 取反
 */
loreRouter.post('/import', async (req, res) => {
  const worldId = getWorldId(req)
  const body: unknown = req.body

  let rawEntries: unknown[] = []
  if (Array.isArray(body)) {
    rawEntries = body
  } else if (body && typeof body === 'object') {
    const entries = (body as Record<string, unknown>).entries
    if (Array.isArray(entries)) rawEntries = entries
    else if (entries && typeof entries === 'object') rawEntries = Object.values(entries)
  }
  if (rawEntries.length === 0) {
    res.status(400).json({ error: '未找到 entries, 请确认是 SillyTavern 世界书 JSON' })
    return
  }

  // 第一遍: 过滤出可导入条目 (无常驻逻辑, 没有关键词的条目不导入)
  const valid: Array<{ keys: string[]; content: string; order: number; enabled: boolean }> = []
  let skipped = 0
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') {
      skipped++
      continue
    }
    const e = item as WorldInfoEntry
    const keys = parseKeys(e.key ?? e.keys)
    const content = typeof e.content === 'string' ? e.content.trim() : ''
    if (keys.length === 0 || !content) {
      skipped++
      continue
    }
    valid.push({
      keys: keys.slice(0, 50),
      content: content.slice(0, 20000),
      order: typeof e.order === 'number' ? e.order : 1,
      enabled: e.disable !== true,
    })
  }
  if (valid.length === 0) {
    res.json({ imported: 0, skipped })
    return
  }

  // 第二遍: order 归一化到 0-10, 保留相对优先级 (SillyTavern 常用 100 起步)
  const orders = valid.map((v) => v.order)
  const minOrder = Math.min(...orders)
  const maxOrder = Math.max(...orders)
  const now = new Date().toISOString()
  let imported = 0
  for (const v of valid) {
    const priority =
      maxOrder === minOrder
        ? 5
        : Math.round(((v.order - minOrder) / (maxOrder - minOrder)) * 10)
    await db.insert(schema.loreEntries).values({
      id: randomUUID(),
      keys: v.keys,
      content: v.content,
      priority,
      enabled: v.enabled,
      worldId,
      createdAt: now,
      updatedAt: now,
    })
    imported++
  }

  res.json({ imported, skipped })
})

// 更新
loreRouter.put('/:id', async (req, res) => {
  const parsed = loreUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await scopedLoreEntry(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'lore entry not found in current world' })
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
  const existing = await scopedLoreEntry(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'lore entry not found in current world' })
    return
  }
  await db.delete(schema.loreEntries).where(eq(schema.loreEntries.id, req.params.id))
  res.status(204).end()
})
