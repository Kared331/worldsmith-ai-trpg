import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { chat } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'
import { HttpError } from '../lib/http-error.js'

// ============================================================
// 性格演变服务: 统计 trait 知识条目 → 阈值判断 → GM 生成演变建议
// ============================================================

/** trait 提议阈值: 同一标签出现次数达到此值才提议 */
const TRAIT_THRESHOLD = 3

export interface TraitStat {
  trait: string
  count: number
}

export interface TraitSuggestionResult {
  suggestion: {
    trait: string
    count: number
    currentPersonality: string
    gmText: string
  } | null
  reason?: string
  traitStats: TraitStat[]
}

/** 自动演化结果 */
export interface AutoEvolveResult {
  characterId: string
  evolved: boolean
  /** 新追加的 trait 列表 */
  addedTraits: string[]
  /** 演化前的 personality */
  before: string
  /** 演化后的 personality */
  after: string
}

/** 统计角色 trait 知识条目, 返回按出现次数降序排列的统计 */
export async function countCharacterTraits(characterId: string): Promise<TraitStat[]> {
  const traits = await db.query.knowledgeEntries.findMany({
    where: (k, { and, eq: eqFn }) =>
      and(eqFn(k.ownerId, characterId), eqFn(k.type, 'trait')),
  })
  const counts = new Map<string, number>()
  for (const t of traits) {
    const key = t.content.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([trait, count]) => ({ trait, count }))
    .sort((a, b) => b.count - a.count)
}

/** 生成性格演变建议 (统计 → 阈值 → GM 建议) */
export async function suggestTrait(
  characterId: string,
): Promise<TraitSuggestionResult> {
  const character = await db.query.characters.findFirst({
    where: eq(schema.characters.id, characterId),
  })
  if (!character) {
    throw new HttpError(404, 'character not found')
  }

  const ranked = await countCharacterTraits(characterId)
  const top = ranked[0]

  // 阈值: 同一 trait 出现 >= 3 次才提议
  if (!top || top.count < TRAIT_THRESHOLD) {
    return {
      suggestion: null,
      reason: '性格标签积累不足（同一标签需出现 3 次以上）',
      traitStats: ranked.slice(0, 5),
    }
  }

  // GM 生成演变建议文案
  let gmText = ''
  try {
    gmText = await chat(
      [
        {
          role: 'system',
          content: [
            `你是 worldsmith 的 Game Master。角色 "${character.name}" 当前人格锚点: "${character.personality}"。`,
            `该角色近期多次表现出特质: "${top.trait}"（出现 ${top.count} 次）。`,
            '请判断这个特质是否值得并入人格锚点，并给出 2-3 句简短建议（说明理由、如何更新锚点）。',
            '若你认为不应合并，请说明原因。',
          ].join('\n'),
        },
        { role: 'user', content: '给出你的建议。' },
      ],
      { endpoint: resolveRole('gm'), temperature: 0.7 },
    )
  } catch (err) {
    gmText = `（GM 建议生成失败: ${err instanceof Error ? err.message : err}）`
  }

  return {
    suggestion: {
      trait: top.trait,
      count: top.count,
      currentPersonality: character.personality,
      gmText,
    },
    traitStats: ranked.slice(0, 5),
  }
}

/**
 * 自动性格演化: 记忆提取后自动调用
 * 统计 trait → 达阈值的 trait 自动并入 personality 锚点
 * - 仅追加尚不在 personality 中的 trait (去重)
 * - 不调用 LLM (纯统计驱动, 避免延迟)
 * - 返回演化结果供日志记录
 */
export async function autoEvolvePersonality(characterId: string): Promise<AutoEvolveResult> {
  const character = await db.query.characters.findFirst({
    where: eq(schema.characters.id, characterId),
  })
  if (!character) {
    return { characterId, evolved: false, addedTraits: [], before: '', after: '' }
  }

  const before = character.personality
  // 当前 personality 已有的 trait (逗号分隔, trim, 小写比较)
  const existing = before
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  // 统计 trait, 找出达到阈值且不在 personality 中的
  const ranked = await countCharacterTraits(characterId)
  const toAdd: string[] = []
  for (const { trait, count } of ranked) {
    if (count < TRAIT_THRESHOLD) break // 已按 count 降序, 后续都不会达标
    const traitLower = trait.trim().toLowerCase()
    if (existing.includes(traitLower)) continue
    // 去重 (同一 trait 可能大小写不同)
    if (toAdd.some((t) => t.toLowerCase() === traitLower)) continue
    toAdd.push(trait.trim())
  }

  if (toAdd.length === 0) {
    return {
      characterId,
      evolved: false,
      addedTraits: [],
      before,
      after: before,
    }
  }

  // 追加到 personality
  const after = [before, ...toAdd].filter(Boolean).join(',')
  await db
    .update(schema.characters)
    .set({ personality: after, updatedAt: new Date().toISOString() })
    .where(eq(schema.characters.id, characterId))

  console.log(
    `[trait] auto-evolved "${character.name}": +${toAdd.join(', ')} (count threshold ${TRAIT_THRESHOLD})`,
  )

  return {
    characterId,
    evolved: true,
    addedTraits: toAdd,
    before,
    after,
  }
}
