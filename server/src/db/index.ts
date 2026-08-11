import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, isNull } from 'drizzle-orm'
import * as schema from './schema.js'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(process.cwd(), 'data')
fs.mkdirSync(dataDir, { recursive: true })

const sqlite = new Database(path.join(dataDir, 'worldsmith.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export { schema }

// ============================================================
// 启动时确保存在默认世界, 并把无 worldId 的旧数据归到默认世界
// (drizzle migrate 在 index.ts 调用, 此函数在 migrate 之后执行)
// ============================================================

const DEFAULT_WORLD_ID = 'default-world'
const DEFAULT_WORLD_NAME = '世界 1'

/** 确保默认世界存在; 旧数据 (worldId 为 null 的角色/旧 GM 消息等) 归入默认世界 */
export async function ensureDefaultWorld(): Promise<void> {
  // 1. 确保默认世界存在
  const existing = await db.query.worlds.findFirst({
    where: eq(schema.worlds.id, DEFAULT_WORLD_ID),
  })
  if (!existing) {
    const now = new Date().toISOString()
    await db.insert(schema.worlds).values({
      id: DEFAULT_WORLD_ID,
      name: DEFAULT_WORLD_NAME,
      description: '默认世界',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    console.log(`[db] 已创建默认世界 "${DEFAULT_WORLD_NAME}"`)
  }

  // 2. 旧数据迁移: 把 worldId 为 null 的角色归到默认世界
  //    (角色库概念是删除世界时"保留角色"才产生 null, 初始旧数据应归到默认世界)
  const orphanChars = await db.query.characters.findMany({
    where: isNull(schema.characters.worldId),
  })
  if (orphanChars.length > 0) {
    await db
      .update(schema.characters)
      .set({ worldId: DEFAULT_WORLD_ID })
      .where(isNull(schema.characters.worldId))
    console.log(`[db] 已将 ${orphanChars.length} 个旧角色归入默认世界`)
  }
}
