import { randomUUID } from 'node:crypto'
import { and, eq, or, like } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { KnowledgeEntry } from '../db/schema.js'

// ============================================================
// KnowledgeService: 统一知识条目 (角色经历/世界Lore/场景信息)
// 检索采用 SQLite LIKE 子串匹配 + 应用层评分
// (零模型依赖, 中文友好, 个人项目规模毫秒级)
// ============================================================

export interface CreateKnowledgeInput {
  scope: 'character' | 'world' | 'scene'
  ownerId: string
  timestamp: string
  type: 'event' | 'trait' | 'relationship' | 'lore' | 'quest'
  content: string
  tags?: string[]
  importance?: number
}

/** 创建条目: SQLite 落库 */
export async function createKnowledgeEntry(
  input: CreateKnowledgeInput,
): Promise<KnowledgeEntry> {
  const id = randomUUID()
  const row = {
    id,
    scope: input.scope,
    ownerId: input.ownerId,
    timestamp: input.timestamp,
    type: input.type,
    content: input.content,
    tags: input.tags ?? [],
    importance: input.importance ?? 3,
    createdAt: new Date().toISOString(),
  }
  await db.insert(schema.knowledgeEntries).values(row)
  return row
}

/** 删除条目 */
export async function deleteKnowledgeEntry(id: string): Promise<boolean> {
  const result = await db
    .delete(schema.knowledgeEntries)
    .where(eq(schema.knowledgeEntries.id, id))
  return result.changes > 0
}

/**
 * 关键词检索: 多关键词 OR LIKE 匹配 + 应用层评分
 * 评分 = 命中词数 * importance - 内容长度惩罚 (越短越相关)
 */
export async function searchKnowledge(
  query: string,
  opts: { ownerId?: string; topK?: number } = {},
): Promise<Array<{ entry: KnowledgeEntry; score: number }>> {
  const topK = opts.topK ?? 5
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[%_]/g, (m) => '\\' + m)) // 转义 LIKE 通配符
  if (terms.length === 0) return []

  // 构造 OR LIKE 条件 (任一词命中即候选)
  const likeConds = terms.map((t) =>
    like(schema.knowledgeEntries.content, `%${t}%`),
  )
  const where = opts.ownerId
    ? and(eq(schema.knowledgeEntries.ownerId, opts.ownerId), or(...likeConds))
    : or(...likeConds)

  const rows = await db
    .select()
    .from(schema.knowledgeEntries)
    .where(where)
    .limit(100)

  // 应用层评分: 命中词数 * importance + 短内容加成
  const scored = rows.map((entry) => {
    const lower = entry.content.toLowerCase()
    let hitCount = 0
    for (const t of terms) {
      if (lower.includes(t.toLowerCase())) hitCount++
    }
    const lenPenalty = Math.min(entry.content.length / 100, 5) // 0-5, 越长扣分
    const score = hitCount * entry.importance - lenPenalty
    return { entry, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(({ entry, score }) => ({ entry, score }))
}
