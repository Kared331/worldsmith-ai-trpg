import { randomUUID } from 'node:crypto'
import { and, eq, or, like, desc, inArray } from 'drizzle-orm'
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

/**
 * 取用于对话上下文注入的记忆条目: 角色记忆 + 世界记忆, 按重要度倒序。
 *
 * 角色记忆按 ownerId 严格隔离: 传单个角色就是 1v1 对话,
 * 传多个角色就是群聊 (只取在场成员的私人记忆, 不会串到不在场角色)。
 *
 * 这里刻意不做关键词检索: 剧情对话与记忆条目的词面重合度低, LIKE 匹配
 * 命中率不稳定, 很可能一条都捞不到。固定注入"最重要的最近 N 条"更可靠,
 * 也便于控制 token 预算。
 */
export async function getRecentMemories(opts: {
  characterIds: string[]
  worldId: string
  limit?: number
}): Promise<KnowledgeEntry[]> {
  const limit = opts.limit ?? 6
  if (opts.characterIds.length === 0) return []
  return db.query.knowledgeEntries.findMany({
    where: or(
      and(
        eq(schema.knowledgeEntries.scope, 'character'),
        inArray(schema.knowledgeEntries.ownerId, opts.characterIds),
      ),
      and(
        eq(schema.knowledgeEntries.scope, 'world'),
        eq(schema.knowledgeEntries.ownerId, opts.worldId),
      ),
    ),
    orderBy: [desc(schema.knowledgeEntries.importance), desc(schema.knowledgeEntries.createdAt)],
    limit,
  })
}
