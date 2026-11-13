import express, { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'

// ============================================================
// 系统维护接口: 整库备份 / 恢复
//
// 备份用 SQLite 的 VACUUM INTO 生成一致性快照, WAL 模式下同样安全,
// 比直接拷贝 .db 文件可靠 (后者可能拷到未 checkpoint 的半状态)。
//
// 恢复不能在线替换正在使用的数据库文件 (Windows 下文件锁会拒绝),
// 因此只落盘为 .pending, 由下次启动时的 pending-restore 应用。
// ============================================================

const dataDir = path.resolve(process.cwd(), 'data')
const SQLITE_HEADER = 'SQLite format 3\u0000'

export const systemRouter = Router()

// 下载整库备份
systemRouter.get('/backup', (_req, res) => {
  const tmpFile = path.join(dataDir, `.backup-${randomUUID()}.db`)
  try {
    db.$client.exec(`VACUUM INTO '${tmpFile.replace(/'/g, "''")}'`)
    const buf = fs.readFileSync(tmpFile)
    fs.rmSync(tmpFile, { force: true })
    const name = `worldsmith-${new Date().toISOString().slice(0, 10)}.db`
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(buf)
  } catch (err) {
    fs.rmSync(tmpFile, { force: true })
    res.status(500).json({ error: `备份失败: ${err instanceof Error ? err.message : err}` })
  }
})

// 上传备份 (重启后生效)
systemRouter.post(
  '/restore',
  express.raw({ type: 'application/octet-stream', limit: '512mb' }),
  (req, res) => {
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length < 100) {
      res.status(400).json({ error: '请以 application/octet-stream 上传 .db 文件' })
      return
    }
    if (buf.subarray(0, 16).toString('utf8') !== SQLITE_HEADER) {
      res.status(400).json({ error: '不是有效的 SQLite 数据库文件' })
      return
    }
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(path.join(dataDir, 'worldsmith.db.pending'), buf)
      res.json({ ok: true, message: '备份已接收，重启服务后生效' })
    } catch (err) {
      res.status(500).json({ error: `保存失败: ${err instanceof Error ? err.message : err}` })
    }
  },
)
