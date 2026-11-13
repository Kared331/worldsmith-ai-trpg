import { Router } from 'express'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { readCharCard, writeCharCard, toCharCard, fromCharCard } from '../cards/png.js'
import { randomUUID } from 'node:crypto'
import { getWorldId } from '../lib/world-context.js'
import { scopedCharacter } from '../lib/scope.js'

export const cardsRouter = Router()

// 导入: base64 PNG → 创建角色
cardsRouter.post('/import', async (req, res) => {
  const parsed = z
    .object({ base64Png: z.string().min(1) })
    .safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'base64Png required' })
    return
  }
  const buffer = Buffer.from(parsed.data.base64Png, 'base64')
  const card = readCharCard(buffer)
  if (!card) {
    res.status(400).json({ error: '无法解析 PNG 角色卡 (无 chara chunk)' })
    return
  }
  const fields = fromCharCard(card)
  const id = randomUUID()
  const now = new Date().toISOString()
  const worldId = getWorldId(req)
  await db.insert(schema.characters).values({
    id,
    name: fields.name,
    personality: fields.personality,
    background: fields.background,
    scenario: fields.scenario || null,
    firstMessage: fields.firstMessage || null,
    // 角色卡 PNG 本身即头像
    avatar: `data:image/png;base64,${buffer.toString('base64')}`,
    worldId,
    createdAt: now,
    updatedAt: now,
  })
  const row = await db.query.characters.findFirst({ where: eq(schema.characters.id, id) })
  res.status(201).json(row)
})

// 导出: 角色 → PNG 下载
cardsRouter.get('/export/:id', async (req, res) => {
  const character = await scopedCharacter(req.params.id, getWorldId(req))
  if (!character) {
    res.status(404).json({ error: 'character not found in current world' })
    return
  }
  const card = toCharCard(character)
  // avatar 存为 data URL, 提取原始 buffer 嵌入导出卡
  let avatar: Buffer | null = null
  if (character.avatar?.startsWith('data:image/png;base64,')) {
    avatar = Buffer.from(character.avatar.split(',')[1], 'base64')
  }
  const png = writeCharCard(card, avatar)
  res.setHeader('Content-Type', 'image/png')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(character.name)}.png"`,
  )
  res.send(png)
})
