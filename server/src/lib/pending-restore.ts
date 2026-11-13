import fs from 'node:fs'
import path from 'node:path'

// ============================================================
// 启动前应用待恢复的数据库备份。
//
// 恢复流程: 前端上传 .db → 服务端落盘为 data/worldsmith.db.pending
//          → 用户重启 → 这里把 .pending 换到正式库位置。
//
// ⚠️ 必须在 db/index.ts 打开数据库之前 import, 否则文件被占用无法替换。
// ============================================================

const dataDir = path.resolve(process.cwd(), 'data')
const dbPath = path.join(dataDir, 'worldsmith.db')
const pendingPath = path.join(dataDir, 'worldsmith.db.pending')

if (fs.existsSync(pendingPath)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    // 旧库留一份 .bak, 恢复错了还能手工回滚
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, `${dbPath}.bak`)
    }
    // WAL / SHM 必须一起清掉, 否则新库会读到旧库的未提交页
    for (const suffix of ['-wal', '-shm']) {
      const p = dbPath + suffix
      if (fs.existsSync(p)) fs.rmSync(p, { force: true })
    }
    fs.copyFileSync(pendingPath, dbPath)
    fs.rmSync(pendingPath, { force: true })
    console.log('[db] 已应用待恢复的备份 (旧库保留为 worldsmith.db.bak)')
  } catch (err) {
    console.warn(
      `[db] 应用备份失败, 继续使用现有数据库: ${err instanceof Error ? err.message : err}`,
    )
  }
}
