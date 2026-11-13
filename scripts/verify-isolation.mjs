// 多世界隔离 / 流式中止 回归验证 (零依赖, 纯 Node)
//
// 用法: node scripts/verify-isolation.mjs
// 行为: 在系统临时目录建一个全新数据库副本, 起一个假 LLM 和服务端, 跑断言后自动清理。
//       不会读写 server/data/ 与 server/llm.config.json。
//
// 覆盖 (对应 docs/fix-blueprint-2026-10-16.md §6 回归矩阵 #1 / #10, 以及 F-14):
//   F-12 跨世界访问拦截: 用世界 A 的 header 访问世界 B 的资源 -> 404
//   同世界访问不误伤 -> 200, 且世界书只返回本世界条目
//   F-15 未知世界 -> 400 (不再静默降级); 世界管理接口豁免 -> 200
//   F-14 客户端断开 -> 上游 LLM 请求被 abort
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.VERIFY_PORT ?? 3999)
const FAKE_PORT = Number(process.env.VERIFY_FAKE_PORT ?? 3888)
const BASE = `http://127.0.0.1:${PORT}`

// ---------- 准备隔离的临时工作目录 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worldsmith-verify-'))
fs.cpSync(path.join(root, 'server', 'drizzle'), path.join(tmp, 'drizzle'), { recursive: true })

let pass = 0
let fail = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// ---------------- 假 LLM: 延迟 10s 才回包, 用于观察中止是否透传 ----------------
let fakeAborted = false
let fakeFinished = false
const fakeLlm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const timer = setTimeout(() => {
      if (res.destroyed) return
      fakeFinished = true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '（假 LLM 回复）', tool_calls: [] } }],
        }),
      )
    }, 10_000)
    // 上游连接被断开 → 说明 worldsmith 把 abort 透传下来了
    req.on('close', () => {
      if (!fakeFinished) {
        fakeAborted = true
        clearTimeout(timer)
      }
    })
  })
})

// ---------------- 写临时配置 ----------------
const llmConfig = {
  activeProvider: 'fake',
  providers: [
    {
      id: 'fake',
      name: 'Fake',
      baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
      apiKey: 'test-key',
      models: [{ id: 'fake-model' }],
    },
  ],
  roleMapping: {
    gm: 'fake/fake-model',
    character: 'fake/fake-model',
    compressor: 'fake/fake-model',
    embedding: 'fake/fake-model',
  },
  defaults: { temperature: 0.7, maxTokens: 64, streaming: true },
}
fs.writeFileSync(path.join(tmp, 'llm.config.json'), JSON.stringify(llmConfig, null, 2))

// ---------------- 启动服务端 ----------------
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const srv = spawn(process.execPath, [tsx, path.join(root, 'server', 'src', 'index.ts')], {
  cwd: tmp,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let srvLog = ''
srv.stdout.on('data', (d) => (srvLog += d))
srv.stderr.on('data', (d) => (srvLog += d))

function req(method, url, worldId, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (worldId) headers['x-world-id'] = worldId
  return fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

try {
  await new Promise((r) => fakeLlm.listen(FAKE_PORT, '127.0.0.1', r))
  const ready = await waitReady()
  if (!ready) {
    console.log('❌ 服务端未就绪\n' + srvLog)
    process.exit(1)
  }
  console.log('=== 服务端已就绪 ===')

  // ---------- 造数据: 两个世界各一个角色 + 各一条世界书 ----------
  const w2 = await (await req('POST', '/api/worlds', null, { name: '世界B' })).json()
  const charA = await (await req('POST', '/api/characters', 'default-world', { name: '甲' })).json()
  const charB = await (await req('POST', '/api/characters', w2.id, { name: '乙' })).json()
  const loreA = await (
    await req('POST', '/api/lore', 'default-world', { keys: ['龙族'], content: 'A的龙族' })
  ).json()
  const loreB = await (
    await req('POST', '/api/lore', w2.id, { keys: ['龙族'], content: 'B的龙族' })
  ).json()
  check(Boolean(charA.id && charB.id && loreA.id && loreB.id), '已造数据: 2 世界 / 2 角色 / 2 世界书')

  console.log('\n=== F-12 跨世界访问拦截 (用世界 A 的 header 访问世界 B 的资源) ===')
  let r = await req('GET', `/api/characters/${charB.id}`, 'default-world')
  check(r.status === 404, 'GET 世界B角色 → 404', `实际 ${r.status}`)
  r = await req('PUT', `/api/characters/${charB.id}`, 'default-world', { name: '被篡改' })
  check(r.status === 404, 'PUT 世界B角色 → 404', `实际 ${r.status}`)
  r = await req('DELETE', `/api/characters/${charB.id}`, 'default-world')
  check(r.status === 404, 'DELETE 世界B角色 → 404', `实际 ${r.status}`)
  r = await req('DELETE', `/api/lore/${loreB.id}`, 'default-world')
  check(r.status === 404, 'DELETE 世界B世界书 → 404', `实际 ${r.status}`)
  r = await req('PUT', `/api/lore/${loreB.id}`, 'default-world', { content: 'x' })
  check(r.status === 404, 'PUT 世界B世界书 → 404', `实际 ${r.status}`)
  r = await req('POST', `/api/worlds/library/characters/${charB.id}/detach`, 'default-world')
  check(r.status === 404, '把世界B角色移入角色库 → 404', `实际 ${r.status}`)

  console.log('\n=== 同世界访问仍然正常 (不能误伤) ===')
  r = await req('GET', `/api/characters/${charA.id}`, 'default-world')
  check(r.status === 200, 'GET 世界A角色 → 200', `实际 ${r.status}`)
  r = await req('GET', `/api/lore`, 'default-world')
  const listA = await r.json()
  check(
    listA.length === 1 && listA[0].id === loreA.id,
    'GET 世界A世界书 → 只返回 1 条',
    `实际 ${listA.length} 条`,
  )
  r = await req('GET', `/api/lore`, w2.id)
  const listB = await r.json()
  check(
    listB.length === 1 && listB[0].id === loreB.id,
    'GET 世界B世界书 → 只返回 1 条',
    `实际 ${listB.length} 条`,
  )

  console.log('\n=== F-15 未知世界返回 400 (不再静默降级) ===')
  r = await req('GET', '/api/characters', 'ghost-world')
  check(r.status === 400, '未知世界访问业务接口 → 400', `实际 ${r.status}`)
  const errBody = await r.json().catch(() => ({}))
  check(String(errBody.error ?? '').includes('unknown world'), '错误信息含 unknown world')

  console.log('\n=== 世界管理接口豁免 (否则世界被删后前端无法自救) ===')
  r = await req('GET', '/api/worlds', 'ghost-world')
  check(r.status === 200, '未知世界访问 /api/worlds → 200', `实际 ${r.status}`)

  console.log('\n=== import 目标世界校验 ===')
  r = await req(
    'POST',
    `/api/worlds/library/characters/${charB.id}/import?worldId=does-not-exist`,
    'default-world',
  )
  check(r.status === 404, '导入到不存在的世界 → 404', `实际 ${r.status}`)

  console.log('\n=== F-14 中止透传到上游 LLM ===')
  // GM 元对话 → 非流式 tool calling → 会等待假 LLM 10s
  const ctrl = new AbortController()
  const p = fetch(`${BASE}/api/gm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-world-id': 'default-world' },
    body: JSON.stringify({ content: '测试中止' }),
    signal: ctrl.signal,
  }).catch(() => null)
  await new Promise((r) => setTimeout(r, 800)) // 等它建立起上游连接
  ctrl.abort()
  await p
  await new Promise((r) => setTimeout(r, 1200)) // 留时间让服务端处理 close
  check(fakeAborted, '客户端断开后, 上游 LLM 请求被 abort (不再空烧 token)')
  check(!fakeFinished, '假 LLM 未跑完 (确认是中止而非等到了超时)')
} catch (e) {
  console.log('❌ 探测异常:', e?.message ?? e)
  fail++
} finally {
  fakeLlm.close()
  // 等子进程真正退出再删临时目录: Windows 上 SQLite 文件句柄释放有延迟,
  // 立刻 rmSync 会 EBUSY
  await new Promise((resolve) => {
    if (srv.exitCode !== null || srv.killed) {
      resolve()
      return
    }
    const done = () => resolve()
    srv.once('exit', done)
    srv.kill()
    setTimeout(done, 3000)
  })
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // 句柄仍未释放时忽略: 临时目录残留无害, 系统会回收
  }
  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`)
  if (fail > 0) console.log('--- 服务端日志 ---\n' + srvLog.slice(-2000))
  process.exit(fail > 0 ? 1 : 0)
}
