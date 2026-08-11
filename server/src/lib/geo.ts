import { randomUUID } from 'node:crypto'
import { eq, and, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

// ============================================================
// 地理工具: 最近节点查找 + 连线查重, 供 routes 和 skills 共用
// 所有操作按世界隔离, 不会跨世界连线
// ============================================================

/** 查找距离 (x, y) 最近的已存在地点 (排除自身, 限当前世界), 返回 null 表示无其他节点 */
export async function findNearestLocation(
  excludeId: string,
  x: number,
  y: number,
  worldId: string,
): Promise<{ id: string; name: string } | null> {
  const existing = await db.query.locations.findMany({
    where: eq(schema.locations.worldId, worldId),
  })
  let nearest: { id: string; name: string } | null = null
  let minDist = Infinity
  for (const loc of existing) {
    if (loc.id === excludeId) continue
    const d = (loc.x - x) ** 2 + (loc.y - y) ** 2
    if (d < minDist) {
      minDist = d
      nearest = loc
    }
  }
  return nearest
}

/** 查询两地之间是否已有连线 (双向) */
export async function connectionExists(a: string, b: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.locationConnections)
    .where(
      or(
        and(
          eq(schema.locationConnections.fromId, a),
          eq(schema.locationConnections.toId, b),
        ),
        and(
          eq(schema.locationConnections.fromId, b),
          eq(schema.locationConnections.toId, a),
        ),
      ),
    )
  return rows.length > 0
}

/** 自动连线: 新节点连接最近的已存在节点 (若尚未连线, 限当前世界) */
export async function autoConnect(
  newId: string,
  x: number,
  y: number,
  worldId: string,
): Promise<{ id: string; name: string } | null> {
  const nearest = await findNearestLocation(newId, x, y, worldId)
  if (nearest && !(await connectionExists(newId, nearest.id))) {
    await db.insert(schema.locationConnections).values({
      id: randomUUID(),
      fromId: nearest.id,
      toId: newId,
    })
  }
  return nearest
}
