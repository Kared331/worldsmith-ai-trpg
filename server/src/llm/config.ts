import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { LlmConfig, LlmProviderConfig, LlmRole } from '@worldsmith/shared'

// ---------- schema 校验 ----------

const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      contextWindow: z.number().optional(),
    }),
  ),
  capabilities: z.array(z.string()).optional(),
})

export const llmConfigSchema = z.object({
  activeProvider: z.string(),
  providers: z.array(providerSchema),
  roleMapping: z.record(z.string(), z.string()),
  defaults: z.object({
    temperature: z.number(),
    maxTokens: z.number(),
    streaming: z.boolean(),
  }),
})

// ---------- 加载 + 缓存 + 热更新 ----------

const CONFIG_PATH = path.resolve(process.cwd(), 'llm.config.json')

let cached: LlmConfig | null = null
let watcher: fs.FSWatcher | null = null
let watchTimer: NodeJS.Timeout | null = null

const emitter = new EventEmitter()

/** ${env:XXX} 占位符解析 (递归) */
function resolveEnv(value: unknown, seen = new Set<string>()): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (match, name: string) => {
      if (seen.has(name)) {
        throw new Error(`cyclic env reference: ${name}`)
      }
      const next = new Set(seen)
      next.add(name)
      return resolveEnv(process.env[name] ?? '', next) as string
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, seen))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnv(v, seen)
    }
    return out
  }
  return value
}

/** 从磁盘加载并校验配置 (每次重新读取) */
export function loadConfig(): LlmConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as unknown
  const parsed = llmConfigSchema.parse(raw)
  cached = resolveEnv(parsed) as LlmConfig
  return cached
}

/** 获取当前配置 (带缓存, 热更新自动失效) */
export function getConfig(): LlmConfig {
  if (!cached) loadConfig()
  return cached as LlmConfig
}

/** 注册配置变更回调 */
export function onConfigChange(cb: (config: LlmConfig) => void): () => void {
  emitter.on('change', cb)
  return () => emitter.off('change', cb)
}

/** 启动文件监听 (热更新) */
export function startConfigWatch(): void {
  if (watcher) return
  watcher = fs.watch(CONFIG_PATH, () => {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      try {
        const next = loadConfig()
        emitter.emit('change', next)
        console.log('[llm] config reloaded')
      } catch (err) {
        console.error('[llm] config reload failed, keeping previous:', err)
      }
    }, 100)
  })
}

// ---------- 角色解析 ----------

export interface ResolvedEndpoint {
  providerId: string
  modelId: string
  baseUrl: string
  apiKey: string
  contextWindow?: number
  capabilities: string[]
}

/** 按角色解析出实际调用的 provider + model 端点 */
export function resolveRole(role: LlmRole): ResolvedEndpoint {
  const cfg = getConfig()
  const mapping = cfg.roleMapping[role]
  if (!mapping) {
    throw new Error(`no roleMapping for role "${role}"`)
  }
  const [providerId, ...modelParts] = mapping.split('/')
  const modelId = modelParts.join('/')
  const provider = cfg.providers.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error(`roleMapping "${role}" -> unknown provider "${providerId}"`)
  }
  const model = provider.models.find((m) => m.id === modelId)
  return {
    providerId: provider.id,
    modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    contextWindow: model?.contextWindow,
    capabilities: provider.capabilities ?? [],
  }
}

// 启动即加载 + 热更新
loadConfig()
startConfigWatch()

// ---------- 写回 .env (仅 API key) ----------

const ENV_PATH = path.resolve(process.cwd(), '.env')

/** 把 API key 写回 .env (保留其他行, 已存在则更新, 不存在则追加) */
export function writeEnvKeys(keys: Record<string, string>): void {
  const lines: string[] = []
  const seen = new Set<string>()

  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && keys[m[1]] !== undefined) {
        // 命中要更新的 key: 用新值替换
        lines.push(`${m[1]}=${keys[m[1]]}`)
        seen.add(m[1])
      } else {
        lines.push(line)
      }
    }
  }

  // 追加 .env 中不存在的新 key
  for (const [k, v] of Object.entries(keys)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`)
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8')

  // 同步到当前进程环境变量 (无需重启即可生效)
  for (const [k, v] of Object.entries(keys)) {
    process.env[k] = v
  }
}

// ---------- 模型自动扫描 ----------

/** 从 baseUrl 解析出环境变量名 (匹配 ${env:XXX}) */
function extractEnvName(apiKey: string): string | null {
  const m = apiKey.match(/^\$\{env:([A-Za-z0-9_]+)\}$/)
  return m ? m[1] : null
}

/** 扫描 OpenAI 兼容端点的可用模型列表 */
export async function scanProviderModels(providerId: string): Promise<string[]> {
  const cfg = getConfig()
  const provider = cfg.providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`provider "${providerId}" not found`)

  // 解析真实 apiKey
  let apiKey = provider.apiKey
  const envName = extractEnvName(provider.apiKey)
  if (envName) apiKey = process.env[envName] ?? ''

  // Ollama 无需 key; 其他 provider 缺 key 则报错
  if (!apiKey && providerId !== 'ollama') {
    throw new Error(`no apiKey for provider "${providerId}"`)
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  // Anthropic 无 /models 端点, 直接返回配置中声明的模型
  if (providerId === 'anthropic') {
    return provider.models.map((m) => m.id)
  }

  // OpenAI 兼容: GET /models
  const res = await fetch(`${provider.baseUrl}/models`, { headers })
  if (!res.ok) {
    throw new Error(`scan failed: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> }
  return (data.data ?? []).map((m) => m.id).sort()
}

// ---------- 保存完整配置 ----------

/** 把配置写回 llm.config.json (保留 ${env:XXX} 占位符) */
export function saveConfig(next: LlmConfig): void {
  // 校验
  const parsed = llmConfigSchema.parse(next)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
  // loadConfig 会由 fs.watch 触发, 但手动调用确保即时生效
  cached = resolveEnv(parsed) as LlmConfig
  emitter.emit('change', cached)
}

/** 更新单个 provider 的 apiKey (写 .env) */
export function updateProviderApiKey(providerId: string, apiKey: string): void {
  const cfg = getConfig()
  const provider = cfg.providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`provider "${providerId}" not found`)

  const envName = extractEnvName(provider.apiKey)
  if (envName) {
    // 占位符模式: 写回 .env
    writeEnvKeys({ [envName]: apiKey })
    // 触发 config 重载 (apiKey 已在 process.env 更新)
    cached = loadConfig()
    emitter.emit('change', cached)
  } else if (providerId === 'ollama') {
    // ollama 本来就无 key, 忽略
  } else {
    // 直接明文写在 JSON 里的情况: 更新 JSON
    const next = {
      ...cfg,
      providers: cfg.providers.map((p) =>
        p.id === providerId ? { ...p, apiKey } : p,
      ),
    }
    saveConfig(next)
  }
}
