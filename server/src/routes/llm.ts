import { Router } from 'express'
import { z } from 'zod'
import {
  getConfig,
  resolveRole,
  saveConfig,
  scanProviderModels,
  updateProviderApiKey,
} from '../llm/config.js'
import type { LlmConfig, LlmRole } from '@worldsmith/shared'
import { LlmError } from '../llm/client.js'

export const llmRouter = Router()

/** 配置脱敏: 不泄露 apiKey 明文 */
function sanitizeConfig(cfg: LlmConfig): LlmConfig {
  return {
    ...cfg,
    providers: cfg.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? '***set***' : '',
    })),
  }
}

// 查看配置 (apiKey 脱敏)
llmRouter.get('/config', (_req, res) => {
  res.json(sanitizeConfig(getConfig()))
})

// 各角色当前解析到的端点状态
llmRouter.get('/endpoints', (_req, res) => {
  const roles = ['gm', 'character', 'compressor', 'embedding'] as const
  const out = roles.map((role) => {
    try {
      const ep = resolveRole(role)
      return {
        role,
        providerId: ep.providerId,
        modelId: ep.modelId,
        baseUrl: ep.baseUrl,
        apiKeyConfigured: Boolean(ep.apiKey),
        contextWindow: ep.contextWindow ?? null,
      }
    } catch (err) {
      return { role, error: err instanceof Error ? err.message : String(err) }
    }
  })
  res.json(out)
})

// ---------- 写入: 完整配置 ----------
const fullConfigSchema = z.object({
  activeProvider: z.string(),
  providers: z.array(
    z.object({
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
    }),
  ),
  roleMapping: z.record(z.string(), z.string()),
  defaults: z.object({
    temperature: z.number(),
    maxTokens: z.number(),
    streaming: z.boolean(),
  }),
})

llmRouter.put('/config', (req, res) => {
  const parsed = fullConfigSchema.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'invalid config' })
    return
  }
  try {
    // 前端提交的是脱敏后的配置 (apiKey 为 "***set***")。
    // 保存时必须恢复当前真实 key (占位符或明文), 否则会把掩码值写回配置文件导致认证失败
    const current = getConfig()
    const restored = {
      ...parsed.data,
      providers: parsed.data.providers.map((p) => {
        const cur = current.providers.find((cp) => cp.id === p.id)
        if (p.apiKey === '***set***' && cur?.apiKey) {
          return { ...p, apiKey: cur.apiKey }
        }
        return p
      }),
    } as LlmConfig
    saveConfig(restored)
    res.json(sanitizeConfig(getConfig()))
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ---------- 写入: 仅默认参数 (温度/maxTokens/streaming) ----------
const defaultsSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(128000),
  streaming: z.boolean(),
})

llmRouter.put('/defaults', (req, res) => {
  const parsed = defaultsSchema.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'invalid defaults' })
    return
  }
  try {
    const cfg = getConfig()
    saveConfig({ ...cfg, defaults: parsed.data })
    res.json(sanitizeConfig(getConfig()))
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ---------- 写入: 角色路由 ----------
const roleMappingSchema = z
  .record(z.string(), z.string())
  .refine(
    (m) => ['gm', 'character', 'compressor', 'embedding'].every((r) => m[r]),
    { message: 'roleMapping must cover gm/character/compressor/embedding' },
  )

llmRouter.put('/role-mapping', (req, res) => {
  const parsed = roleMappingSchema.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'invalid roleMapping' })
    return
  }
  try {
    const cfg = getConfig()
    saveConfig({ ...cfg, roleMapping: parsed.data as Record<LlmRole, string> })
    res.json(sanitizeConfig(getConfig()))
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ---------- 写入: 单个 provider 的 API key ----------
llmRouter.put('/providers/:id/api-key', (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : ''
  try {
    updateProviderApiKey(req.params.id, apiKey)
    res.json({ ok: true })
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ---------- 扫描可用模型 ----------
llmRouter.post('/providers/:id/scan-models', async (req, res) => {
  try {
    const models = await scanProviderModels(req.params.id)
    res.json({ models })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('no apiKey') ? 400 : 502
    res.status(status).json({ error: msg })
  }
})

// ---------- 写入: 更新 provider 的模型列表 (扫描后确认) ----------
const providerModelsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      contextWindow: z.number().optional(),
    }),
  ),
})

llmRouter.put('/providers/:id/models', (req, res) => {
  const parsed = providerModelsSchema.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'invalid models' })
    return
  }
  try {
    const cfg = getConfig()
    saveConfig({
      ...cfg,
      providers: cfg.providers.map((p) =>
        p.id === req.params.id ? { ...p, models: parsed.data.models } : p,
      ),
    })
    res.json(sanitizeConfig(getConfig()))
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// 暴露 LlmError 供 error handler 识别 (非路由, 仅类型导出占位)
export type { LlmError }
