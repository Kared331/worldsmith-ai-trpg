import { randomUUID } from 'node:crypto'
import { eq, and, or, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { ToolDef } from '../llm/client.js'
import { autoConnect, connectionExists } from '../lib/geo.js'
import { chatService } from '../chat/service.js'

// ============================================================
// Skills 工具集: 代码引擎暴露给 GM 的确定性函数
// GM 通过 function calling 调用, 结果回填到对话
// 所有 skill 通过 args._worldId 获取当前世界 (由 gm/service 注入)
// ============================================================

/** 从 skill args 中提取 worldId (gm/service 注入) */
function worldIdFromArgs(args: Record<string, unknown>): string {
  return String(args._worldId ?? 'default-world')
}

// ============================================================
// Skills 工具集: 代码引擎暴露给 GM 的确定性函数
// GM 通过 function calling 调用, 结果回填到对话
// ============================================================

export interface Skill {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

/** d20 掷骰 (确定性随机) */
function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1
}

/** 伤害骰解析, 如 "2d6" → 掷 2 颗 d6 */
function rollDice(spec: string): number {
  const m = /^(\d+)d(\d+)$/.exec(spec.trim())
  if (!m) return 0
  const [count, sides] = [Number(m[1]), Number(m[2])]
  let total = 0
  for (let i = 0; i < count; i++) {
    total += Math.floor(Math.random() * sides) + 1
  }
  return total
}

const skills: Skill[] = [
  {
    name: 'roll_attack',
    description:
      '攻击判定: 掷 d20 + 攻击加成 vs 目标防御。返回 命中/暴击(自然20)/未命中 与伤害值。',
    parameters: {
      type: 'object',
      properties: {
        attacker: { type: 'string', description: '攻击者名称' },
        attackBonus: { type: 'number', description: '攻击检定加成' },
        defense: { type: 'number', description: '目标防御等级' },
        damageDice: {
          type: 'string',
          description: '伤害骰表达式, 如 "1d8"',
          default: '1d6',
        },
      },
      required: ['attacker', 'attackBonus', 'defense'],
    },
    handler: (args) => {
      const bonus = Number(args.attackBonus ?? 0)
      const defense = Number(args.defense ?? 10)
      const roll = rollD20()
      const total = roll + bonus
      const crit = roll === 20
      const hit = crit || total >= defense
      const damage = hit ? rollDice(String(args.damageDice ?? '1d6')) : 0
      return {
        roll,
        bonus,
        total,
        defense,
        hit,
        crit,
        damage,
        summary: crit
          ? `自然20! 暴击! 造成 ${damage * 2} 点伤害`
          : hit
            ? `命中! 造成 ${damage} 点伤害`
            : `未命中 (${total} vs ${defense})`,
      }
    },
  },
  {
    name: 'roll_skill_check',
    description:
      '属性检定: 掷 d20 + 属性修正 vs 难度等级 (DC)。返回 成功/失败 与成功程度。',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: '进行检定的角色名' },
        stat: { type: 'string', description: '属性名, 如 力量/敏捷/智力' },
        modifier: { type: 'number', description: '属性修正值' },
        difficulty: { type: 'number', description: '难度等级 DC (5易/10中/15难/20极难)' },
      },
      required: ['character', 'stat', 'modifier', 'difficulty'],
    },
    handler: (args) => {
      const modifier = Number(args.modifier ?? 0)
      const dc = Number(args.difficulty ?? 10)
      const roll = rollD20()
      const total = roll + modifier
      const success = total >= dc
      return {
        roll,
        modifier,
        total,
        difficulty: dc,
        success,
        degree: success ? total - dc : dc - total,
        summary: `${args.character} 的${args.stat}检定: ${roll}${modifier >= 0 ? '+' : ''}${modifier} = ${total} vs DC${dc} → ${success ? '成功' : '失败'}`,
      }
    },
  },
  {
    name: 'get_world_state',
    description:
      '获取当前世界状态摘要: 已有角色、对话、任务等系统事实。GM 做决策前建议调用。',
    parameters: { type: 'object', properties: {} },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const characters = await db.query.characters.findMany({
        where: eq(schema.characters.worldId, worldId),
      })
      const conversations = await db.query.conversations.findMany({
        where: eq(schema.conversations.worldId, worldId),
      })
      // 任务: scope=world 且 ownerId=worldId (避免拉到其他世界的任务)
      const quests = await db.query.knowledgeEntries.findMany({
        where: (k, { and, eq: eqFn }) =>
          and(eqFn(k.scope, 'world'), eqFn(k.ownerId, worldId), eqFn(k.type, 'quest')),
      })
      return {
        worldId,
        characters: characters.map((c) => ({
          id: c.id,
          name: c.name,
          personality: c.personality,
        })),
        conversationCount: conversations.length,
        activeQuests: quests.map((q) => ({
          id: q.id,
          title: q.tags?.[0] ?? '未命名任务',
          location: q.tags?.[1] ?? '',
          content: q.content.slice(0, 200),
        })),
      }
    },
  },
  {
    name: 'create_quest',
    description: '创建任务: 写入世界任务记录, 玩家可在界面上查看和修改。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名' },
        description: { type: 'string', description: '任务详细描述' },
        location: { type: 'string', description: '任务地点' },
        importance: {
          type: 'number',
          description: '重要性 1-5',
          default: 3,
        },
      },
      required: ['name', 'description'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const id = randomUUID()
      await db.insert(schema.knowledgeEntries).values({
        id,
        scope: 'world',
        ownerId: worldId,
        timestamp: new Date().toISOString().slice(0, 16),
        type: 'quest',
        content: String(args.description ?? ''),
        tags: [String(args.name), String(args.location ?? '')].filter(Boolean),
        importance: Number(args.importance ?? 3),
        createdAt: new Date().toISOString(),
      })
      return { id, worldId, name: args.name, location: args.location ?? '', created: true }
    },
  },
  {
    name: 'get_quests',
    description: '列出当前世界的所有任务。',
    parameters: { type: 'object', properties: {} },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const quests = await db.query.knowledgeEntries.findMany({
        where: (k, { and, eq: eqFn }) =>
          and(eqFn(k.scope, 'world'), eqFn(k.ownerId, worldId), eqFn(k.type, 'quest')),
      })
      return quests.map((q) => ({
        id: q.id,
        name: q.tags?.[0] ?? '未命名',
        location: q.tags?.[1] ?? '',
        description: q.content,
        importance: q.importance,
      }))
    },
  },
  {
    name: 'create_location',
    description:
      '在世界地图上创建新地点节点（自动连线到最近地点）。GM 认为剧情需要新地点时调用。可指定坐标，不传则自动散布。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '地点名称' },
        type: {
          type: 'string',
          enum: ['town', 'forest', 'mountain', 'lake', 'dungeon', 'other'],
          description: '地点类型',
          default: 'other',
        },
        description: { type: 'string', description: '地点描述', default: '' },
        x: { type: 'number', description: '地图 x 坐标 (可选, 不传则自动散布)', default: 0 },
        y: { type: 'number', description: '地图 y 坐标 (可选, 不传则自动散布)', default: 0 },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const id = randomUUID()
      const now = new Date().toISOString()
      const type = ['town', 'forest', 'mountain', 'lake', 'dungeon', 'other'].includes(
        String(args.type),
      )
        ? (args.type as string)
        : 'other'

      // 坐标: GM 传了就用, 没传则基于当前世界现有节点做环形散布 (避免堆叠在原点)
      let x = Number(args.x ?? 0)
      let y = Number(args.y ?? 0)
      if (args.x === undefined && args.y === undefined) {
        const existing = await db.query.locations.findMany({
          where: eq(schema.locations.worldId, worldId),
        })
        if (existing.length === 0) {
          x = 200
          y = 150
        } else {
          // 环形散布: 半径随节点数增长, 角度均分
          const radius = 120 + existing.length * 30
          const angle = (existing.length * 137.5 * Math.PI) / 180 // 黄金角散布
          x = Math.round(300 + radius * Math.cos(angle))
          y = Math.round(200 + radius * Math.sin(angle))
        }
      }

      await db.insert(schema.locations).values({
        id,
        name: String(args.name),
        description: String(args.description ?? ''),
        type: type as 'other',
        x,
        y,
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      // 自动连线到最近节点 (基于真实坐标, 限当前世界)
      const nearest = await autoConnect(id, x, y, worldId)
      return {
        id,
        worldId,
        name: args.name,
        x,
        y,
        created: true,
        connectedTo: nearest?.name ?? null,
      }
    },
  },
  {
    name: 'update_location',
    description: '更新已有地点的名称、描述、类型或坐标。GM 需要修改地图时调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '地点 ID' },
        name: { type: 'string', description: '新名称 (可选)' },
        description: { type: 'string', description: '新描述 (可选)' },
        type: {
          type: 'string',
          enum: ['town', 'forest', 'mountain', 'lake', 'dungeon', 'other'],
          description: '新类型 (可选)',
        },
        x: { type: 'number', description: '新 x 坐标 (可选)' },
        y: { type: 'number', description: '新 y 坐标 (可选)' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const existing = await db.query.locations.findFirst({
        where: (l, { and, eq: eqFn }) =>
          and(eqFn(l.id, String(args.id)), eqFn(l.worldId, worldId)),
      })
      if (!existing) return { error: `location "${args.id}" not found in current world` }
      const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
      if (args.name !== undefined) updates.name = String(args.name)
      if (args.description !== undefined) updates.description = String(args.description)
      if (args.type !== undefined) updates.type = args.type
      if (args.x !== undefined) updates.x = Number(args.x)
      if (args.y !== undefined) updates.y = Number(args.y)
      await db.update(schema.locations).set(updates).where(eq(schema.locations.id, String(args.id)))
      return { id: args.id, updated: true, fields: Object.keys(updates).filter((k) => k !== 'updatedAt') }
    },
  },
  {
    name: 'create_connection',
    description: '在两个地点之间创建道路/连线。GM 需要连接特定地点时调用。',
    parameters: {
      type: 'object',
      properties: {
        fromName: { type: 'string', description: '起点地点名称' },
        toName: { type: 'string', description: '终点地点名称' },
      },
      required: ['fromName', 'toName'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const fromLoc = await db.query.locations.findFirst({
        where: (l, { and, eq: eqFn }) =>
          and(eqFn(l.name, String(args.fromName)), eqFn(l.worldId, worldId)),
      })
      const toLoc = await db.query.locations.findFirst({
        where: (l, { and, eq: eqFn }) =>
          and(eqFn(l.name, String(args.toName)), eqFn(l.worldId, worldId)),
      })
      if (!fromLoc) return { error: `location "${args.fromName}" not found in current world` }
      if (!toLoc) return { error: `location "${args.toName}" not found in current world` }
      if (fromLoc.id === toLoc.id) return { error: 'cannot connect a location to itself' }
      if (await connectionExists(fromLoc.id, toLoc.id)) {
        return { ok: true, existed: true, from: args.fromName, to: args.toName }
      }
      await db.insert(schema.locationConnections).values({
        id: randomUUID(),
        fromId: fromLoc.id,
        toId: toLoc.id,
      })
      return { ok: true, created: true, from: args.fromName, to: args.toName }
    },
  },
  {
    name: 'create_character',
    description: '创建新角色卡。GM 需要引入新 NPC 时调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名' },
        personality: { type: 'string', description: '人格关键词, 逗号分隔 (如 "勇敢,善良,冲动")', default: '' },
        background: { type: 'string', description: '背景故事', default: '' },
        appearance: { type: 'string', description: '外貌描述 (可选)' },
        firstMessage: { type: 'string', description: '开场白 (可选)' },
        scenario: { type: 'string', description: '场景设定 (可选)' },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const id = randomUUID()
      const now = new Date().toISOString()
      await db.insert(schema.characters).values({
        id,
        name: String(args.name),
        personality: String(args.personality ?? ''),
        background: String(args.background ?? ''),
        appearance: args.appearance ? String(args.appearance) : null,
        firstMessage: args.firstMessage ? String(args.firstMessage) : null,
        scenario: args.scenario ? String(args.scenario) : null,
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      return { id, worldId, name: args.name, created: true }
    },
  },
  {
    name: 'update_character',
    description: '更新已有角色的属性 (人格/背景/外貌/开场白/场景)。GM 需要角色成长或修正时调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名 (用于定位角色)' },
        personality: { type: 'string', description: '新人格关键词 (可选)' },
        background: { type: 'string', description: '新背景故事 (可选)' },
        appearance: { type: 'string', description: '新外貌描述 (可选)' },
        firstMessage: { type: 'string', description: '新开场白 (可选)' },
        scenario: { type: 'string', description: '新场景设定 (可选)' },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const character = await db.query.characters.findFirst({
        where: (c, { and, eq: eqFn }) =>
          and(eqFn(c.name, String(args.name)), eqFn(c.worldId, worldId)),
      })
      if (!character) return { error: `character "${args.name}" not found in current world` }
      const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
      if (args.personality !== undefined) updates.personality = String(args.personality)
      if (args.background !== undefined) updates.background = String(args.background)
      if (args.appearance !== undefined) updates.appearance = String(args.appearance)
      if (args.firstMessage !== undefined) updates.firstMessage = String(args.firstMessage)
      if (args.scenario !== undefined) updates.scenario = String(args.scenario)
      await db.update(schema.characters).set(updates).where(eq(schema.characters.id, character.id))
      // 失效角色缓存, 让后续对话使用新属性
      chatService.invalidateCharacter(character.id)
      return { id: character.id, worldId, name: args.name, updated: true, fields: Object.keys(updates).filter((k) => k !== 'updatedAt') }
    },
  },
  {
    name: 'update_player_state',
    description: '管理玩家运行时状态栏。可添加新状态项、更新值或删除。GM 在剧情中改变 HP/位置/时间/物品等时调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'delete'],
          description: 'set = 添加或更新状态项, delete = 删除状态项',
          default: 'set',
        },
        key: { type: 'string', description: '状态键名 (如 "hp", "location", "time", "inventory", "gold")' },
        value: { type: 'string', description: '状态值 (action=set 时必填)' },
        label: { type: 'string', description: '显示标签 (如 "HP", "位置"), 新建时使用, 更新时可选' },
        icon: {
          type: 'string',
          description: 'lucide 图标名 (如 "Heart", "MapPin", "Clock", "Backpack", "Coins")',
          default: 'Activity',
        },
      },
      required: ['key'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const key = String(args.key)
      const action = String(args.action ?? 'set')
      // 多世界隔离: 用 (key, worldId) 复合条件, 避免跨世界状态串扰
      const existing = await db.query.playerStates.findFirst({
        where: (p, { and, eq: eqFn }) => and(eqFn(p.key, key), eqFn(p.worldId, worldId)),
      })
      if (action === 'delete') {
        if (!existing) return { ok: true, deleted: false, reason: 'not found' }
        await db.delete(schema.playerStates).where(eq(schema.playerStates.id, existing.id))
        return { ok: true, deleted: true, key, worldId }
      }
      // set
      const value = String(args.value ?? '')
      const now = new Date().toISOString()
      if (existing) {
        const updates: Record<string, unknown> = { value, updatedAt: now }
        if (args.label !== undefined) updates.label = String(args.label)
        if (args.icon !== undefined) updates.icon = String(args.icon)
        await db.update(schema.playerStates).set(updates).where(eq(schema.playerStates.id, existing.id))
        return { ok: true, key, value, worldId, updated: true }
      }
      // 新建
      await db.insert(schema.playerStates).values({
        id: randomUUID(),
        key,
        label: String(args.label ?? key),
        value,
        icon: String(args.icon ?? 'Activity'),
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      return { ok: true, key, value, worldId, created: true }
    },
  },
  {
    name: 'update_character_state',
    description:
      '管理角色运行时状态（动态角色卡）。可添加/更新/删除某个角色的状态项，如心情、位置、好感度、HP、装备等。用于体现角色在剧情中的动态变化，区别于静态角色卡设定。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'delete'],
          description: 'set = 添加或更新状态项, delete = 删除状态项',
          default: 'set',
        },
        characterId: {
          type: 'string',
          description: '目标角色 ID (必填, 指定要修改哪个角色的状态)',
        },
        key: {
          type: 'string',
          description: '状态键名 (如 "mood", "location", "relationship", "hp", "equipment")',
        },
        value: { type: 'string', description: '状态值 (action=set 时必填)' },
        label: {
          type: 'string',
          description: '显示标签 (如 "心情", "位置", "好感度"), 新建时使用, 更新时可选',
        },
        icon: {
          type: 'string',
          description: 'lucide 图标名 (如 "Heart", "MapPin", "Brain", "Smile", "Sword")',
          default: 'Activity',
        },
      },
      required: ['characterId', 'key'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const characterId = String(args.characterId)
      const key = String(args.key)
      const action = String(args.action ?? 'set')

      // 校验角色存在**且属于当前世界** (或为角色库 null)
      // 否则 GM 可给任意世界的角色写状态, 造出 (characterId 属世界 B, worldId 属世界 A) 的脏行
      const character = await db.query.characters.findFirst({
        where: (c, { and: andFn, eq: eqFn, or: orFn, isNull: isNullFn }) =>
          andFn(
            eqFn(c.id, characterId),
            orFn(eqFn(c.worldId, worldId), isNullFn(c.worldId)),
          ),
      })
      if (!character) {
        return { ok: false, error: `character "${characterId}" not found in current world` }
      }

      // 多世界 + 多角色复合条件
      const existing = await db.query.characterStates.findFirst({
        where: (s, { and: andFn, eq: eqFn }) =>
          andFn(
            eqFn(s.characterId, characterId),
            eqFn(s.key, key),
            eqFn(s.worldId, worldId),
          ),
      })

      if (action === 'delete') {
        if (!existing) return { ok: true, deleted: false, reason: 'not found' }
        await db.delete(schema.characterStates).where(eq(schema.characterStates.id, existing.id))
        return { ok: true, deleted: true, characterId, key, worldId }
      }

      // set
      const value = String(args.value ?? '')
      const now = new Date().toISOString()
      if (existing) {
        const updates: Record<string, unknown> = { value, updatedAt: now }
        if (args.label !== undefined) updates.label = String(args.label)
        if (args.icon !== undefined) updates.icon = String(args.icon)
        await db
          .update(schema.characterStates)
          .set(updates)
          .where(eq(schema.characterStates.id, existing.id))
        return { ok: true, characterId, key, value, worldId, updated: true }
      }

      // 新建
      await db.insert(schema.characterStates).values({
        id: randomUUID(),
        characterId,
        key,
        label: String(args.label ?? key),
        value,
        icon: String(args.icon ?? 'Activity'),
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      return { ok: true, characterId, key, value, worldId, created: true }
    },
  },
  {
    name: 'create_world_rule',
    description:
      '创建世界规则。世界规则是当前世界的设定约束，会注入到所有对话的 system prompt，角色和 GM 都必须遵守。GM 认为需要明确某些设定时调用（如魔法系统、战斗规则、世界禁忌）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '规则标题, 如 "魔法系统"、"战斗规则"、"世界禁忌"' },
        content: { type: 'string', description: '规则详细内容' },
        category: {
          type: 'string',
          enum: ['system', 'combat', 'magic', 'world', 'other'],
          description: '规则分类: system=系统机制, combat=战斗, magic=魔法, world=世界设定, other=其他',
          default: 'other',
        },
      },
      required: ['title', 'content'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const id = randomUUID()
      const now = new Date().toISOString()
      const category = ['system', 'combat', 'magic', 'world', 'other'].includes(String(args.category))
        ? (args.category as string)
        : 'other'
      await db.insert(schema.worldRules).values({
        id,
        title: String(args.title),
        content: String(args.content),
        category,
        author: 'gm',
        enabled: true,
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      return { id, worldId, title: args.title, category, author: 'gm', created: true }
    },
  },
  {
    name: 'update_world_rule',
    description: '更新已有世界规则的内容、分类或启用状态。GM 需要修正或细化规则时调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '要更新的规则标题 (用于定位规则)' },
        newTitle: { type: 'string', description: '新标题 (可选)' },
        content: { type: 'string', description: '新内容 (可选)' },
        category: {
          type: 'string',
          enum: ['system', 'combat', 'magic', 'world', 'other'],
          description: '新分类 (可选)',
        },
        enabled: { type: 'boolean', description: '是否启用 (可选)' },
      },
      required: ['title'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const existing = await db.query.worldRules.findFirst({
        where: (r, { and: andFn, eq: eqFn }) =>
          andFn(eqFn(r.title, String(args.title)), eqFn(r.worldId, worldId)),
      })
      if (!existing) return { error: `rule "${args.title}" not found in current world` }
      const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
      if (args.newTitle !== undefined) updates.title = String(args.newTitle)
      if (args.content !== undefined) updates.content = String(args.content)
      if (args.category !== undefined) updates.category = args.category
      if (args.enabled !== undefined) updates.enabled = args.enabled
      await db.update(schema.worldRules).set(updates).where(eq(schema.worldRules.id, existing.id))
      return { id: existing.id, worldId, title: existing.title, updated: true, fields: Object.keys(updates).filter((k) => k !== 'updatedAt') }
    },
  },
  {
    name: 'delete_world_rule',
    description: '删除世界规则。规则不再适用时调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '要删除的规则标题' },
      },
      required: ['title'],
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const existing = await db.query.worldRules.findFirst({
        where: (r, { and: andFn, eq: eqFn }) =>
          andFn(eqFn(r.title, String(args.title)), eqFn(r.worldId, worldId)),
      })
      if (!existing) return { error: `rule "${args.title}" not found in current world` }
      await db.delete(schema.worldRules).where(eq(schema.worldRules.id, existing.id))
      return { ok: true, deleted: true, title: args.title, worldId }
    },
  },
  {
    name: 'get_world_rules',
    description: '列出当前世界的所有规则。GM 做决策前可调用了解世界约束。',
    parameters: { type: 'object', properties: {} },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const rules = await db.query.worldRules.findMany({
        where: eq(schema.worldRules.worldId, worldId),
      })
      return rules.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content.slice(0, 500),
        category: r.category,
        author: r.author,
        enabled: r.enabled,
      }))
    },
  },

  // ============================================================
  // 扩展 GM 权限: 世界书 / 关系 / 伏笔 / 环境
  // ============================================================

  {
    name: 'add_lore_entry',
    description: '向世界书添加条目: 关键词触发后自动注入对话上下文。GM 在剧情中扩展世界观、补充设定时调用。',
    parameters: {
      type: 'object',
      required: ['keys', 'content'],
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: '触发关键词数组, 任一命中即注入 (如 ["龙族", "古龙"])',
        },
        content: { type: 'string', description: '条目内容 (会注入对话)' },
        priority: { type: 'number', description: '优先级, 数字越大越靠前 (默认 1)', default: 1 },
        enabled: { type: 'boolean', description: '是否启用 (默认 true)', default: true },
      },
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const keys = Array.isArray(args.keys) ? args.keys.filter(Boolean) : []
      if (keys.length === 0) return { error: 'keys 不能为空' }
      const id = randomUUID()
      const now = new Date().toISOString()
      await db.insert(schema.loreEntries).values({
        id,
        keys,
        content: String(args.content ?? ''),
        priority: Number(args.priority ?? 1),
        enabled: args.enabled !== false,
        worldId,
        createdAt: now,
        updatedAt: now,
      })
      return { id, worldId, keys, created: true }
    },
  },

  {
    name: 'create_relationship',
    description: '建立两个角色间的关系记录。GM 设定角色间的敌对/盟友/恋人/师徒等关系时调用。',
    parameters: {
      type: 'object',
      required: ['fromName', 'toName', 'relation'],
      properties: {
        fromName: { type: 'string', description: '角色 A 名称' },
        toName: { type: 'string', description: '角色 B 名称' },
        relation: {
          type: 'string',
          description: '关系类型, 如 "恋人"/"敌对"/"盟友"/"师徒"/"兄妹"/"仇人"',
        },
        detail: { type: 'string', description: '关系详细描述 (可选)', default: '' },
        importance: {
          type: 'number',
          description: '重要度 1-5 (默认 3)',
          default: 3,
        },
      },
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const fromChar = await db.query.characters.findFirst({
        where: and(
          eq(schema.characters.name, String(args.fromName)),
          or(eq(schema.characters.worldId, worldId), isNull(schema.characters.worldId)),
        ),
      })
      if (!fromChar) return { error: `未找到角色: ${args.fromName}` }
      const id = randomUUID()
      const now = new Date().toISOString()
      await db.insert(schema.knowledgeEntries).values({
        id,
        scope: 'character',
        ownerId: fromChar.id,
        timestamp: now,
        type: 'relationship',
        content: `${args.fromName} → ${args.toName}: ${args.relation}${args.detail ? ` (${args.detail})` : ''}`,
        tags: [String(args.toName), String(args.relation)],
        importance: Number(args.importance ?? 3),
        createdAt: now,
      })
      return {
        id,
        worldId,
        from: args.fromName,
        to: args.toName,
        relation: args.relation,
        created: true,
      }
    },
  },

  {
    name: 'create_foreshadowing',
    description: '埋下伏笔/事件记录: 写入世界知识库, 供后续剧情回收。GM 想埋线索、记录重要事件时调用。',
    parameters: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: '伏笔/事件内容描述' },
        timestamp: {
          type: 'string',
          description: '游戏内时间戳 (如 "第3天·夜晚"), 不传则用现实时间',
          default: '',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签 (如 ["伏笔", "主线"])',
          default: [],
        },
        importance: {
          type: 'number',
          description: '重要度 1-5 (默认 3, 5 为关键剧情)',
          default: 3,
        },
      },
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const id = randomUUID()
      const now = new Date().toISOString()
      const tags = Array.isArray(args.tags) ? args.tags : []
      tags.push('foreshadowing')
      await db.insert(schema.knowledgeEntries).values({
        id,
        scope: 'world',
        ownerId: worldId,
        timestamp: String(args.timestamp ?? now),
        type: 'event',
        content: String(args.content),
        tags: Array.from(new Set(tags)),
        importance: Number(args.importance ?? 3),
        createdAt: now,
      })
      return { id, worldId, created: true, importance: Number(args.importance ?? 3) }
    },
  },

  {
    name: 'set_environment',
    description: '设定世界环境状态: 时间/天气/季节/氛围。GM 推进时间、切换天气、营造氛围时调用。会写入玩家状态栏, 玩家可见。',
    parameters: {
      type: 'object',
      properties: {
        time: {
          type: 'string',
          description: '游戏内时间 (如 "清晨"/"正午"/"黄昏"/"深夜"/"第4天·黄昏")',
        },
        weather: {
          type: 'string',
          description: '天气 (如 "晴"/"雨"/"雪"/"雾"/"暴风雨")',
        },
        season: {
          type: 'string',
          description: '季节 (如 "春"/"夏"/"秋"/"冬")',
        },
        atmosphere: {
          type: 'string',
          description: '氛围描述 (如 "诡异的寂静"/"节日的喧闹")',
        },
      },
    },
    handler: async (args) => {
      const worldId = worldIdFromArgs(args)
      const now = new Date().toISOString()
      const updates: Array<{ key: string; value: string; label: string; icon: string }> = []
      if (args.time) updates.push({ key: 'time', value: String(args.time), label: '时间', icon: 'Clock' })
      if (args.weather) updates.push({ key: 'weather', value: String(args.weather), label: '天气', icon: 'Cloud' })
      if (args.season) updates.push({ key: 'season', value: String(args.season), label: '季节', icon: 'Leaf' })
      if (args.atmosphere) updates.push({ key: 'atmosphere', value: String(args.atmosphere), label: '氛围', icon: 'Wind' })

      for (const u of updates) {
        const existing = await db.query.playerStates.findFirst({
          where: and(eq(schema.playerStates.worldId, worldId), eq(schema.playerStates.key, u.key)),
        })
        if (existing) {
          await db.update(schema.playerStates)
            .set({ value: u.value, updatedAt: now })
            .where(eq(schema.playerStates.id, existing.id))
        } else {
          await db.insert(schema.playerStates).values({
            id: randomUUID(),
            worldId,
            key: u.key,
            value: u.value,
            label: u.label,
            icon: u.icon,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
      return {
        worldId,
        updated: updates.map((u) => ({ key: u.key, value: u.value })),
        count: updates.length,
      }
    },
  },
]

const skillMap = new Map(skills.map((s) => [s.name, s]))

export const skillDefs: ToolDef[] = skills.map((s) => ({
  name: s.name,
  description: s.description,
  parameters: s.parameters,
}))

/** 执行 skill, 返回结构化结果 (失败时返回 error 对象而非抛错) */
export async function executeSkill(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const skill = skillMap.get(name)
  if (!skill) {
    return { error: `unknown skill: ${name}`, available: [...skillMap.keys()] }
  }
  try {
    return await skill.handler(args)
  } catch (err) {
    return { error: `skill "${name}" failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
