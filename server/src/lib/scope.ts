import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

// ============================================================
// 世界隔离收口 (single choke point)
//
// 背景: 多世界隔离原先靠"每个 handler 记得写 worldId"的自觉, 结果有 10 处
// `:id` 路由只按主键直查, 未校验归属, 可跨世界读写。
//
// 约定: 任何带 `:id` 的路由, 必须先用这里的 scopedXxx(id, worldId) 取记录,
//       取不到一律返回 404 "not found in current world"。
//       这样"遗漏"在评审时有统一形态, 而不是散落各处的隐患。
// ============================================================

/** 角色库 (worldId = null) 的角色跨世界共享, 因此允许任意世界访问 */
export function scopedCharacter(id: string, worldId: string) {
  return db.query.characters.findFirst({
    where: (c, { and: andFn, eq: eqFn, or: orFn, isNull: isNullFn }) =>
      andFn(eqFn(c.id, id), orFn(eqFn(c.worldId, worldId), isNullFn(c.worldId))),
  })
}

/** 对话必然属于某个世界 */
export function scopedConversation(id: string, worldId: string) {
  return db.query.conversations.findFirst({
    where: (c, { and: andFn, eq: eqFn }) => andFn(eqFn(c.id, id), eqFn(c.worldId, worldId)),
  })
}

export function scopedLoreEntry(id: string, worldId: string) {
  return db.query.loreEntries.findFirst({
    where: (l, { and: andFn, eq: eqFn }) => andFn(eqFn(l.id, id), eqFn(l.worldId, worldId)),
  })
}

export function scopedWorldRule(id: string, worldId: string) {
  return db.query.worldRules.findFirst({
    where: (r, { and: andFn, eq: eqFn }) => andFn(eqFn(r.id, id), eqFn(r.worldId, worldId)),
  })
}

export function scopedLocation(id: string, worldId: string) {
  return db.query.locations.findFirst({
    where: (l, { and: andFn, eq: eqFn }) => andFn(eqFn(l.id, id), eqFn(l.worldId, worldId)),
  })
}

/**
 * GM 结局记录本身没有 worldId 列, 归属通过 gm_messages.world_id 间接确定。
 * 需要两步查询: 先取 outcome, 再校验其 gmMessage 是否属于当前世界。
 */
export async function scopedGmOutcome(id: string, worldId: string) {
  const outcome = await db.query.gmOutcomes.findFirst({
    where: eq(schema.gmOutcomes.id, id),
  })
  if (!outcome) return null
  const owner = await db.query.gmMessages.findFirst({
    where: (m, { and: andFn, eq: eqFn }) => andFn(eqFn(m.id, outcome.gmMessageId), eqFn(m.worldId, worldId)),
    columns: { id: true },
  })
  return owner ? outcome : null
}
