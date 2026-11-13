import 'dotenv/config'
// 必须在 db/index.js 之前: 打开数据库前先应用待恢复的备份
import './lib/pending-restore.js'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db, ensureDefaultWorld, runRuntimeMigrations } from './db/index.js'
import { charactersRouter } from './routes/characters.js'
import { conversationsRouter } from './routes/conversations.js'
import { chatRouter } from './routes/chat.js'
import { llmRouter } from './routes/llm.js'
import { gmRouter } from './routes/gm.js'
import { locationsRouter } from './routes/locations.js'
import { loreRouter } from './routes/lore.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { cardsRouter } from './routes/cards.js'
import { playerStateRouter } from './routes/player-state.js'
import { characterStateRouter } from './routes/character-state.js'
import { worldsRouter } from './routes/worlds.js'
import { personasRouter } from './routes/personas.js'
import { rulesRouter } from './routes/rules.js'
import { systemRouter } from './routes/system.js'
import { worldContextMiddleware } from './lib/world-context.js'
import { errorHandler } from './lib/http-error.js'

// 启动时自动执行迁移 (幂等)
migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })
// 运行时列迁移必须在 drizzle migrate 之后 (表已建好)
runRuntimeMigrations()
// 迁移后确保默认世界存在, 旧数据归入默认世界
// 必须在 listen 之前 await: 否则首个请求可能先到, 触发 world_id 外键失败
await ensureDefaultWorld()

const app = express()
app.use(cors())
app.use(express.json())
// 世界上下文: 解析 x-world-id header, 挂到 req.worldId
app.use(worldContextMiddleware)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'worldsmith-server', version: '0.2.0' })
})

// worlds 路由不需要世界隔离 (它本身就是管理世界的)
app.use('/api/worlds', worldsRouter)
app.use('/api/characters', charactersRouter)
app.use('/api/conversations', conversationsRouter)
app.use('/api/chat', chatRouter)
app.use('/api/llm', llmRouter)
app.use('/api/gm', gmRouter)
app.use('/api/locations', locationsRouter)
app.use('/api/lore', loreRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api/cards', cardsRouter)
app.use('/api/player-state', playerStateRouter)
app.use('/api/character-state', characterStateRouter)
app.use('/api/personas', personasRouter)
app.use('/api/rules', rulesRouter)
app.use('/api/system', systemRouter)

// 全局错误处理 (必须注册在所有路由之后)
app.use(errorHandler)

const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, () => {
  console.log(`[worldsmith] server listening on http://localhost:${PORT}`)
})
