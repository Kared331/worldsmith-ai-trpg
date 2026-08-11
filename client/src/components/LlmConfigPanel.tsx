import { useEffect, useState } from 'react'
import {
  Settings,
  RefreshCw,
  Key,
  Cpu,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
} from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/Dialog'
import { toast } from './ui/Toast'
import { cn } from '../lib/utils'
import type { LlmConfig, LlmRole } from '@worldsmith/shared'

const ROLES: Array<{ key: LlmRole; label: string; hint: string }> = [
  { key: 'character', label: '角色扮演', hint: '角色对话回复' },
  { key: 'gm', label: 'GM 元对话', hint: '与世界规则讨论' },
  { key: 'compressor', label: '记忆压缩', hint: '对话总结提取' },
  { key: 'embedding', label: '嵌入检索', hint: '知识库语义搜索(已改 FTS5, 仅保留兼容)' },
]

export function LlmConfigPanel() {
  const open = useAppStore((s) => s.llmConfigOpen)
  const setOpen = useAppStore((s) => s.setLlmConfigOpen)
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState<string | null>(null)
  const [scannedModels, setScannedModels] = useState<Record<string, string[]>>({})
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

  // 打开时加载配置
  useEffect(() => {
    if (!open) return
    setLoading(true)
    api
      .getLlmConfig()
      .then(setConfig)
      .catch(() => toast.error('配置加载失败'))
      .finally(() => setLoading(false))
  }, [open])

  if (!config) {
    return (
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-xl">
        <DialogHeader onClose={() => setOpen(false)}>
          <DialogTitle>LLM 配置</DialogTitle>
        </DialogHeader>
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          {loading ? '加载中…' : '配置未加载'}
        </div>
      </Dialog>
    )
  }

  // 构造所有可选 "provider/model" 选项
  const allEndpoints: Array<{ value: string; label: string }> = []
  for (const p of config.providers) {
    for (const m of p.models) {
      allEndpoints.push({
        value: `${p.id}/${m.id}`,
        label: `${p.name} · ${m.id}`,
      })
    }
  }

  async function handleScan(providerId: string) {
    setScanning(providerId)
    try {
      const { models } = await api.scanProviderModels(providerId)
      setScannedModels((s) => ({ ...s, [providerId]: models }))
      toast.success(`扫描到 ${models.length} 个模型`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setScanning(null)
    }
  }

  async function handleSaveKey(providerId: string) {
    const key = keyInputs[providerId]
    if (key === undefined) return
    try {
      await api.updateProviderApiKey(providerId, key)
      toast.success('API Key 已保存')
      setKeyInputs((s) => {
        const next = { ...s }
        delete next[providerId]
        return next
      })
      // 刷新配置 (脱敏状态)
      const fresh = await api.getLlmConfig()
      setConfig(fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  async function handleAdoptScanned(providerId: string) {
    const models = scannedModels[providerId]
    if (!models?.length || !config) return
    const provider = config.providers.find((p) => p.id === providerId)
    // 保留已有模型的 contextWindow, 扫描到的新模型默认无
    const oldMap = new Map((provider?.models ?? []).map((m) => [m.id, m]))
    const newModels = models.map((id) => ({
      id,
      contextWindow: oldMap.get(id)?.contextWindow,
    }))
    try {
      const fresh = await api.updateProviderModels(providerId, newModels)
      setConfig(fresh)
      toast.success(`已导入 ${newModels.length} 个模型`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    }
  }

  async function handleRoleChange(role: LlmRole, value: string) {
    if (!config) return
    const nextMapping = { ...config.roleMapping, [role]: value }
    const next: LlmConfig = { ...config, roleMapping: nextMapping }
    setConfig(next)
    try {
      const fresh = await api.updateRoleMapping(nextMapping)
      setConfig(fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '角色路由更新失败')
    }
  }

  function handleDefaultsChange(patch: Partial<LlmConfig['defaults']>) {
    if (!config) return
    const nextDefaults = { ...config.defaults, ...patch }
    setConfig({ ...config, defaults: nextDefaults })
  }

  async function handleSaveDefaults() {
    if (!config) return
    try {
      const fresh = await api.updateDefaults(config.defaults)
      setConfig(fresh)
      toast.success('默认参数已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  function handleModelContextChange(providerId: string, modelId: string, contextWindow: number) {
    if (!config) return
    const fresh: LlmConfig = {
      ...config,
      providers: config.providers.map((p) =>
        p.id === providerId
          ? {
              ...p,
              models: p.models.map((m) =>
                m.id === modelId ? { ...m, contextWindow } : m,
              ),
            }
          : p,
      ),
    }
    setConfig(fresh)
  }

  async function handleSaveModels() {
    if (!config) return
    try {
      const fresh = await api.updateLlmConfig(config)
      setConfig(fresh)
      toast.success('配置已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  return (
    <Dialog open={open} onClose={() => setOpen(false)} className="max-w-2xl">
      <DialogHeader onClose={() => setOpen(false)}>
        <DialogTitle className="flex items-center gap-1.5">
          <Settings className="size-4" /> LLM 配置
        </DialogTitle>
        <DialogDescription>配置模型、API Key、角色路由与生成参数。修改即时热生效，无需重启。</DialogDescription>
      </DialogHeader>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {/* 默认参数 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            默认生成参数
          </h3>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">温度 (0-2)</label>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={config.defaults.temperature}
                onChange={(e) =>
                  handleDefaultsChange({ temperature: Number(e.target.value) })
                }
                onBlur={handleSaveDefaults}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">最大 Token</label>
              <Input
                type="number"
                min="1"
                max="128000"
                value={config.defaults.maxTokens}
                onChange={(e) =>
                  handleDefaultsChange({ maxTokens: Number(e.target.value) })
                }
                onBlur={handleSaveDefaults}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">流式输出</label>
              <button
                className={cn(
                  'flex h-9 w-full items-center justify-center rounded-md border text-sm transition-colors',
                  config.defaults.streaming
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground',
                )}
                onClick={() => {
                  handleDefaultsChange({ streaming: !config.defaults.streaming })
                  setTimeout(handleSaveDefaults, 0)
                }}
              >
                {config.defaults.streaming ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>
        </section>

        {/* 角色路由 */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            角色路由
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {ROLES.map((r) => (
              <div key={r.key} className="space-y-1">
                <label className="text-xs text-muted-foreground" title={r.hint}>
                  {r.label}
                </label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={config.roleMapping[r.key]}
                  onChange={(e) => handleRoleChange(r.key, e.target.value)}
                >
                  {allEndpoints.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-popover">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>

        {/* Provider 逐个配置 */}
        {config.providers.map((p) => {
          const keySet = p.apiKey === '***set***'
          const showInput = showKeys[p.id] ?? false
          const keyValue = keyInputs[p.id] ?? ''
          const scanned = scannedModels[p.id]
          return (
            <section key={p.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Cpu className="size-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.id}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs"
                  disabled={scanning === p.id}
                  onClick={() => handleScan(p.id)}
                >
                  <RefreshCw className={cn('size-3', scanning === p.id && 'animate-spin')} />
                  {scanning === p.id ? '扫描中…' : '扫描模型'}
                </Button>
              </div>

              {/* API Key */}
              {p.id !== 'ollama' && (
                <div className="space-y-1">
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Key className="size-3" /> API Key
                    {keySet && (
                      <span className="inline-flex items-center gap-0.5 text-primary">
                        <Check className="size-3" /> 已设置
                      </span>
                    )}
                  </label>
                  <div className="flex gap-1">
                    <div className="relative flex-1">
                      <Input
                        type={showInput ? 'text' : 'password'}
                        placeholder={keySet ? '已设置 (输入新值覆盖)' : '输入 API Key'}
                        value={keyValue}
                        onChange={(e) =>
                          setKeyInputs((s) => ({ ...s, [p.id]: e.target.value }))
                        }
                        className="pr-8"
                      />
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowKeys((s) => ({ ...s, [p.id]: !s[p.id] }))}
                        type="button"
                      >
                        {showInput ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                    <Button
                      size="sm"
                      className="h-9"
                      disabled={keyValue === undefined || keyValue === ''}
                      onClick={() => handleSaveKey(p.id)}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              )}

              {/* 扫描结果 */}
              {scanned && (
                <div className="rounded bg-secondary/50 p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-muted-foreground">扫描到 {scanned.length} 个模型</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-xs"
                      onClick={() => handleAdoptScanned(p.id)}
                    >
                      导入全部
                    </Button>
                  </div>
                  {scanned.length > 0 && (
                    <div className="max-h-24 overflow-y-auto text-muted-foreground">
                      {scanned.slice(0, 20).map((m) => (
                        <div key={m} className="truncate font-mono">
                          {m}
                        </div>
                      ))}
                      {scanned.length > 20 && <div>…还有 {scanned.length - 20} 个</div>}
                    </div>
                  )}
                </div>
              )}

              {/* 模型列表 + contextWindow */}
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">模型 ({p.models.length})</label>
                {p.models.map((m) => (
                  <div key={m.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                    <Input
                      type="number"
                      min="1024"
                      step="1024"
                      className="h-7 w-24 text-xs"
                      placeholder="上下文"
                      value={m.contextWindow ?? ''}
                      onChange={(e) =>
                        handleModelContextChange(p.id, m.id, Number(e.target.value) || 0)
                      }
                    />
                    <span className="text-xs text-muted-foreground">ctx</span>
                  </div>
                ))}
              </div>
            </section>
          )
        })}

        <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">
          <AlertCircle className="size-3.5 shrink-0 text-amber-500" />
          <span>模型列表改动后点击底部"保存模型配置"生效；API Key 与角色路由已即时保存。</span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
        <Button onClick={handleSaveModels}>
          <Check className="size-4" /> 保存模型配置
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
