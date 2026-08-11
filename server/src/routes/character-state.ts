import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq, and, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWorldId } from '../lib/world-context.js'

const stateUpsertSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(2000).default(''),
  label: z.string().max(50).optional(),
  icon: z.string().max(50).optional(),
})

export const characterStateRouter = Router()

// 列表查询 (当前世界)
//   无参数: 返回当前世界所有角色状态
//   ?characterId=xxx: 返回某角色的所有状态
//   ?characterIds=a,b,c: 批量返回多角色状态 (群聊场景, 按 characterId 分组)
characterStateRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const characterId =
    typeof req.query.characterId === 'string' ? req.query.characterId : undefined
  const characterIdsParam =
    typeof req.query.characterIds === 'string' ? req.query.characterIds : undefined

  // 单角色 / 批量 / 全量三种模式
  let where
  if (characterId) {
    where = and(
      eq(schema.characterStates.characterId, characterId),
      eq(schema.characterStates.worldId, worldId),
    )
  } else if (characterIdsParam) {
    const ids = characterIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) {
      res.json([])
      return
    }
    where = and(
      inArray(schema.characterStates.characterId, ids),
      eq(schema.characterStates.worldId, worldId),
    )
  } else {
    where = eq(schema.characterStates.worldId, worldId)
  }

  const rows = await db.query.characterStates.findMany({
    where,
    orderBy: (s, { asc }) => [asc(s.createdAt)],
  })
  res.json(rows)
})

// 新增或更新 (按 characterId + key + worldId upsert)
characterStateRouter.put('/:characterId', async (req, res) => {
  const parsed = stateUpsertSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const characterId = req.params.characterId

  // 校验角色存在且属于当前世界 (或为角色库 null)
  const character = await db.query.characters.findFirst({
    where: eq(schema.characters.id, characterId),
  })
  if (!character) {
    res.status(404).json({ error: 'character not found' })
    return
  }
  if (character.worldId !== null && character.worldId !== worldId) {
    res.status(403).json({ error: 'character does not belong to current world' })
    return
  }

  const existing = await db.query.characterStates.findFirst({
    where: and(
      eq(schema.characterStates.characterId, characterId),
      eq(schema.characterStates.key, parsed.data.key),
      eq(schema.characterStates.worldId, worldId),
    ),
  })
  const now = new Date().toISOString()
  if (existing) {
    const updates: Record<string, unknown> = { value: parsed.data.value, updatedAt: now }
    if (parsed.data.label) updates.label = parsed.data.label
    if (parsed.data.icon) updates.icon = parsed.data.icon
    await db.update(schema.characterStates).set(updates).where(eq(schema.characterStates.id, existing.id))
    const row = await db.query.characterStates.findFirst({ where: eq(schema.characterStates.id, existing.id) })
    res.json(row)
    return
  }
  const id = randomUUID()
  await db.insert(schema.characterStates).values({
    id,
    characterId,
    key: parsed.data.key,
    value: parsed.data.value,
    label: parsed.data.label ?? parsed.data.key,
    icon: parsed.data.icon ?? 'Activity',
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.characterStates.findFirst({ where: eq(schema.characterStates.id, id) })
  res.status(201).json(row)
})

// 删除 (按 characterId + key + worldId)
characterStateRouter.delete('/:characterId/:key', async (req, res) => {
  const worldId = getWorldId(req)
  const result = await db
    .delete(schema.characterStates)
    .where(
      and(
        eq(schema.characterStates.characterId, req.params.characterId),
        eq(schema.characterStates.key, req.params.key),
        eq(schema.characterStates.worldId, worldId),
      ),
    )
  if (result.changes === 0) {
    res.status(404).json({ error: 'character state not found' })
    return
  }
  res.status(204).end()
})
