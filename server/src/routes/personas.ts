import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { db, schema } from '../db/index.js'

// ============================================================
// 玩家人设 (User Persona) 路由
// 全局表 (不按世界隔离): 玩家身份跨世界一致
// 同一时刻仅一个 isActive=true (设置时先清空其他)
// ============================================================

export const personasRouter = Router()

const personaUpsertSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(5000).default(''),
  avatar: z.string().optional(),
})

/** GET /api/personas/active — 获取当前激活的人设 (可能为 null) */
personasRouter.get('/active', async (_req, res) => {
  const persona = await db.query.userPersonas.findFirst({
    where: eq(schema.userPersonas.isActive, true),
  })
  res.json(persona ?? null)
})

/** PUT /api/personas/active — 创建或更新当前激活的人设 (单例语义) */
personasRouter.put('/active', async (req, res) => {
  const parsed = personaUpsertSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const now = new Date().toISOString()
  // 先把所有人设设为非激活
  await db.update(schema.userPersonas).set({ isActive: false })
  // 查找已存在的激活人设 (此时已全为 false, 用 name 或任意一条)
  const existing = await db.query.userPersonas.findFirst({})
  let persona: typeof schema.userPersonas.$inferSelect | undefined
  if (existing) {
    await db
      .update(schema.userPersonas)
      .set({
        name: parsed.data.name,
        description: parsed.data.description,
        avatar: parsed.data.avatar ?? null,
        isActive: true,
        updatedAt: now,
      })
      .where(eq(schema.userPersonas.id, existing.id))
    persona = await db.query.userPersonas.findFirst({ where: eq(schema.userPersonas.id, existing.id) })
  } else {
    const id = randomUUID()
    await db.insert(schema.userPersonas).values({
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      avatar: parsed.data.avatar ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    persona = await db.query.userPersonas.findFirst({ where: eq(schema.userPersonas.id, id) })
  }
  res.json(persona)
})

/** DELETE /api/personas/active — 清除当前人设 (设为非激活) */
personasRouter.delete('/active', async (_req, res) => {
  await db.update(schema.userPersonas).set({ isActive: false })
  res.status(204).send()
})
