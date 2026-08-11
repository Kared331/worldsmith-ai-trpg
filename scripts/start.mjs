#!/usr/bin/env node
// ============================================================
// worldsmith 一键启动脚本
// 用法: node scripts/start.mjs  (或双击 start.bat / start.sh)
// 功能: 依赖检查 → 配置初始化 → 并行启动前后端 → 打开浏览器
// ============================================================

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, copyFileSync } from 'node:fs'
import { platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const isWindows = platform() === 'win32'
const CLIENT_URL = 'http://localhost:5173'
const SERVER_URL = 'http://localhost:3001'

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function log(msg) {
  console.log(`${COLORS.cyan}[start]${COLORS.reset} ${msg}`)
}

function warn(msg) {
  console.log(`${COLORS.yellow}[start]${COLORS.reset} ${msg}`)
}

// ============================================================
// 1. 环境检查
// ============================================================
const nodeVersion = process.versions.node.split('.').map(Number)
if (nodeVersion[0] < 18) {
  console.error(`${COLORS.yellow}[start] 需要 Node.js >= 18, 当前 ${process.versions.node}${COLORS.reset}`)
  process.exit(1)
}

// ============================================================
// 2. 依赖检查 (首次自动 npm install)
// ============================================================
if (!existsSync(path.join(root, 'node_modules'))) {
  log('首次启动, 正在安装依赖 (npm install)...')
  spawnSync('npm', ['install'], { stdio: 'inherit', shell: isWindows, cwd: root })
  log('依赖安装完成')
}

// ============================================================
// 3. 配置初始化
// ============================================================
const envPath = path.join(root, 'server', '.env')
const envExample = path.join(root, '.env.example')
if (!existsSync(envPath)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envPath)
    log('已创建 server/.env (从 .env.example 复制)')
  } else {
    log('server/.env 不存在, 将使用空值 (Ollama 本地模式可用)')
  }
  warn('→ 编辑 server/.env 填入 API key, 或使用 Ollama 本地模式 (无需 key)')
}

const configPath = path.join(root, 'server', 'llm.config.json')
if (!existsSync(configPath)) {
  warn('→ server/llm.config.json 不存在, 请参考文档创建配置')
} else {
  log('LLM 配置: server/llm.config.json (运行时热更新, 改完即生效)')
}

// ============================================================
// 4. 启动前后端 (并行, 带前缀日志)
// ============================================================
log('启动中... (Ctrl+C 退出)')
console.log(`${COLORS.dim}  前端: ${CLIENT_URL}${COLORS.reset}`)
console.log(`${COLORS.dim}  后端: ${SERVER_URL}${COLORS.reset}`)
console.log()

function startProc(name, color, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, shell: isWindows })
  const prefix = `${color}[${name}]${COLORS.reset} `
  const pipe = (stream, target) => {
    stream?.on('data', (d) => {
      const text = d.toString().replace(/\n$/, '')
      target.write(prefix + text.split('\n').join(`\n${prefix}`) + '\n')
    })
  }
  pipe(p.stdout, process.stdout)
  pipe(p.stderr, process.stderr)
  p.on('exit', (code) => {
    log(`${name} 进程退出 (code ${code})`)
    cleanup()
  })
  return p
}

const client = startProc('client', COLORS.magenta, 'npm', ['run', 'dev'], path.join(root, 'client'))
const server = startProc('server', COLORS.green, 'npm', ['run', 'dev'], path.join(root, 'server'))

// ============================================================
// 5. 延迟打开浏览器 (等 client 起来)
// ============================================================
setTimeout(() => {
  try {
    if (isWindows) {
      spawn('cmd', ['/c', 'start', '', CLIENT_URL], { shell: true, detached: true })
    } else if (platform() === 'darwin') {
      spawn('open', [CLIENT_URL], { detached: true })
    } else {
      spawn('xdg-open', [CLIENT_URL], { detached: true })
    }
    log(`已打开浏览器: ${CLIENT_URL}`)
  } catch {
    warn(`浏览器未自动打开, 请手动访问: ${CLIENT_URL}`)
  }
}, 3500)

// ============================================================
// 6. 进程管理 (任一退出则全部退出)
// ============================================================
let cleaning = false
function cleanup() {
  if (cleaning) return
  cleaning = true
  try { client.kill() } catch {}
  try { server.kill() } catch {}
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
