import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { chatService } from '../chat/service.js'
import { suggestTrait } from '../services/trait.js'
import { asyncHandler } from '../lib/http-error.js'
import { getWorldId } from '../lib/world-context.js'
import { scopedCharacter } from '../lib/scope.js'
import { chat } from '../llm/client.js'
import { resolveRole } from '../llm/config.js'
import { extractJsonRobust } from '../lib/json-extract.js'
import type { CharacterBlock } from '@worldsmith/shared'

const characterCreateSchema = z.object({
  name: z.string().min(1).max(100),
  personality: z.string().max(2000).default(''),
  background: z.string().max(20000).default(''),
  appearance: z.string().max(2000).optional().nullable(),
  firstMessage: z.string().max(4000).optional().nullable(),
  scenario: z.string().max(4000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  blocks: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        title: z.string().min(1).max(100),
        order: z.number().int().min(0),
        fields: z.array(
          z.object({
            key: z.string().min(1),
            label: z.string().max(100),
            value: z.string().max(20000),
            kind: z.enum(['code', 'narrative']),
          }),
        ),
      }),
    )
    .max(50)
    .optional(),
})

const characterUpdateSchema = characterCreateSchema.partial()

export const charactersRouter = Router()

// 列表 (仅当前世界的角色, 不含角色库)
charactersRouter.get('/', async (req, res) => {
  const worldId = getWorldId(req)
  const rows = await db.query.characters.findMany({
    where: eq(schema.characters.worldId, worldId),
    orderBy: (c, { desc }) => [desc(c.updatedAt)],
  })
  res.json(rows)
})

// 创建
charactersRouter.post('/', async (req, res) => {
  const parsed = characterCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const worldId = getWorldId(req)
  const now = new Date().toISOString()
  const id = randomUUID()
  await db.insert(schema.characters).values({ id, ...parsed.data, worldId, createdAt: now, updatedAt: now })
  const row = await db.query.characters.findFirst({ where: eq(schema.characters.id, id) })
  res.status(201).json(row)
})

// 详情
charactersRouter.get('/:id', async (req, res) => {
  const row = await scopedCharacter(req.params.id, getWorldId(req))
  if (!row) {
    res.status(404).json({ error: 'character not found in current world' })
    return
  }
  res.json(row)
})

// 更新 (角色块缓存自动失效: 指纹变化)
charactersRouter.put('/:id', async (req, res) => {
  const parsed = characterUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
    return
  }
  const existing = await scopedCharacter(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'character not found in current world' })
    return
  }
  await db
    .update(schema.characters)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(schema.characters.id, req.params.id))
  chatService.invalidateCharacter(req.params.id)
  const row = await db.query.characters.findFirst({
    where: eq(schema.characters.id, req.params.id),
  })
  res.json(row)
})

// 删除
charactersRouter.delete('/:id', async (req, res) => {
  const existing = await scopedCharacter(req.params.id, getWorldId(req))
  if (!existing) {
    res.status(404).json({ error: 'character not found in current world' })
    return
  }
  const result = await db
    .delete(schema.characters)
    .where(eq(schema.characters.id, req.params.id))
  if (result.changes === 0) {
    res.status(404).json({ error: 'character not found' })
    return
  }
  chatService.invalidateCharacter(req.params.id)
  res.status(204).end()
})

// 性格演变提议 (业务逻辑在 services/trait.ts, 错误由全局中间件处理)
charactersRouter.post(
  '/:id/suggest-trait',
  asyncHandler(async (req, res) => {
    const existing = await scopedCharacter(req.params.id, getWorldId(req))
    if (!existing) {
      res.status(404).json({ error: 'character not found in current world' })
      return
    }
    const result = await suggestTrait(req.params.id)
    res.json(result)
  }),
)

// 自然语言编辑角色卡: 接收自然语言指令 → LLM 解析 → 返回修改后的 blocks (不保存, 前端预览)
const naturalEditSchema = z.object({
  instruction: z.string().min(1).max(2000),
})

charactersRouter.post(
  '/:id/edit-natural',
  asyncHandler(async (req, res) => {
    const parsed = naturalEditSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' })
      return
    }
    const character = await scopedCharacter(req.params.id, getWorldId(req))
    if (!character) {
      res.status(404).json({ error: 'character not found in current world' })
      return
    }

    const currentBlocks: CharacterBlock[] = character.blocks ?? []
    const instruction = parsed.data.instruction

    const systemPrompt = [
      '你是一个角色卡编辑助手。用户会用自然语言描述对角色卡的修改需求，你需要根据指令修改角色卡板块（blocks）。',
      '',
      '当前角色信息：',
      `- 名称: ${character.name}`,
      `- 人格: ${character.personality || '无'}`,
      `- 背景: ${character.background?.slice(0, 500) || '无'}`,
      '',
      '当前角色卡板块 JSON：',
      '```json',
      JSON.stringify(currentBlocks, null, 2),
      '```',
      '',
      '用户指令：',
      instruction,
      '',
      '请根据用户指令修改角色卡板块，输出修改后的完整 JSON。',
      '规则：',
      '1. 保持已有板块的 id 不变（除非用户要求删除）',
      '2. 新增板块用 "b_new_" 前缀加随机字符串作为 id',
      '3. order 字段从 0 开始递增',
      '4. type 字段保持 "custom"',
      '5. 字段 kind 只能是 "code" 或 "narrative"',
      '6. 只输出 JSON，不要输出任何其他内容',
    ].join('\n')

    let resp = ''
    try {
      resp = await chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请执行修改。' },
        ],
        { endpoint: resolveRole('gm'), temperature: 0.3 },
      )
    } catch (err) {
      res.status(500).json({
        error: `LLM 解析失败: ${err instanceof Error ? err.message : err}`,
      })
      return
    }

    // 提取 JSON (容错: 支持 markdown 代码块 / 输出截断 / 尾逗号)
    const { value: newBlocks, parseOk } = extractJsonRobust<CharacterBlock[]>(resp, [])
    if (!parseOk) {
      res.status(500).json({ error: 'LLM 返回格式错误', raw: resp.slice(0, 500) })
      return
    }

    res.json({ blocks: newBlocks, instruction })
  }),
)
