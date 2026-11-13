import { db, schema } from '../db/index.js'

// ============================================================
// Lorebook 注入: 关键词匹配 → 优先级排序 → 预算截断
// ============================================================

export interface MatchedLore {
  id: string
  keys: string[]
  content: string
  priority: number
}

/** 扫描文本命中启用的 Lorebook 条目 (大小写不敏感, 包含匹配)
 *  必须按 worldId 过滤: 世界书按世界隔离, 否则 A 世界的设定会注入 B 世界的对话 */
export async function matchLore(texts: string[], worldId: string): Promise<MatchedLore[]> {
  const entries = await db.query.loreEntries.findMany({
    where: (l, { and, eq }) => and(eq(l.enabled, true), eq(l.worldId, worldId)),
  })
  if (entries.length === 0) return []

  const joined = texts.join('\n').toLowerCase()
  const matched: MatchedLore[] = []
  for (const e of entries) {
    if (e.keys.some((k) => joined.includes(k.toLowerCase()))) {
      matched.push({ id: e.id, keys: e.keys, content: e.content, priority: e.priority })
    }
  }
  return matched.sort((a, b) => b.priority - a.priority)
}

/** 优先级截断: 最多 maxCount 条, 累计不超过 maxChars 字符 */
export function truncateLore(
  entries: MatchedLore[],
  maxCount = 5,
  maxChars = 1500,
): MatchedLore[] {
  const out: MatchedLore[] = []
  let total = 0
  for (const e of entries) {
    if (out.length >= maxCount) break
    if (total + e.content.length > maxChars) break
    out.push(e)
    total += e.content.length
  }
  return out
}

/** 渲染为注入文本块 */
export function renderLore(entries: MatchedLore[]): string {
  return entries.map((l) => `[${l.keys.join('/')}] ${l.content}`).join('\n')
}
