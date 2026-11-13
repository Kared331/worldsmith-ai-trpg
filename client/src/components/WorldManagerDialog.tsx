import { useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Download, Upload, Trash2, Check, X, Globe } from 'lucide-react'
import type { World, WorldExport } from '@worldsmith/shared'
import { useAppStore } from '../store/appStore'
import { DEFAULT_WORLD_ID, api } from '../lib/api'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { Badge } from './ui/Badge'
import { toast } from './ui/Toast'
import { cn } from '../lib/utils'

// ============================================================
// WorldManagerDialog: 世界管理面板
// 功能: 列表 + 新建 + 行内改名 + 导出设定(JSON) + 删除(保留角色/导出设定)
// ============================================================

interface Props {
  open: boolean
  onClose: () => void
  /** 初始模式: list=列表, create=直接展开新建表单 */
  initialMode?: 'list' | 'create'
}

export function WorldManagerDialog({ open, onClose, initialMode = 'list' }: Props) {
  const worlds = useAppStore((s) => s.worlds)
  const activeWorld = useAppStore((s) => s.activeWorld)
  const createWorld = useAppStore((s) => s.createWorld)
  const updateWorld = useAppStore((s) => s.updateWorld)
  const exportWorld = useAppStore((s) => s.exportWorld)
  const deleteWorld = useAppStore((s) => s.deleteWorld)

  const [showCreate, setShowCreate] = useState(initialMode === 'create')
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)

  // 行内编辑状态
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = useState<World | null>(null)
  const [keepCharacters, setKeepCharacters] = useState(true)
  const [exportSettings, setExportSettings] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // 数据备份
  const [backupBusy, setBackupBusy] = useState(false)
  const restoreRef = useRef<HTMLInputElement>(null)

  async function handleBackup() {
    setBackupBusy(true)
    try {
      const blob = await api.backupDatabase()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `worldsmith-${new Date().toISOString().slice(0, 10)}.db`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('备份已下载')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '备份失败')
    } finally {
      setBackupBusy(false)
    }
  }

  async function handleRestore(file: File) {
    if (!window.confirm('恢复会用备份覆盖当前全部数据，重启服务后生效。确定继续？')) return
    setBackupBusy(true)
    try {
      const r = await api.restoreDatabase(file)
      toast.success(r.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setBackupBusy(false)
    }
  }

  // 切换打开状态时重置
  useEffect(() => {
    if (open) {
      setShowCreate(initialMode === 'create')
      setNewName('')
      setNewDesc('')
      setEditingId(null)
      setDeleteTarget(null)
    }
  }, [open, initialMode])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('请输入世界名称')
      return
    }
    setCreating(true)
    const world = await createWorld({ name, description: newDesc.trim() })
    setCreating(false)
    if (world) {
      toast.success(`世界「${world.name}」已创建`)
      setNewName('')
      setNewDesc('')
      setShowCreate(false)
    }
  }

  const startEdit = (w: World) => {
    setEditingId(w.id)
    setEditName(w.name)
    setEditDesc(w.description)
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    const name = editName.trim()
    if (!name) {
      toast.error('世界名称不能为空')
      return
    }
    await updateWorld(editingId, { name, description: editDesc.trim() })
    setEditingId(null)
    toast.success('已保存')
  }

  const handleExport = async (w: World) => {
    const data = await exportWorld(w.id)
    if (data) {
      downloadJson(data, `${w.name}-世界设定.json`)
      toast.success(`已导出「${w.name}」的世界设定`)
    }
  }

  const openDelete = (w: World) => {
    setDeleteTarget(w)
    setKeepCharacters(true)
    setExportSettings(false)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    const result = await deleteWorld(deleteTarget.id, {
      keepCharacters,
      exportSettings,
    })
    setDeleting(false)
    if (result) {
      // 删除接口若勾选了导出设定, 会返回 exportData, 触发下载
      if (result.exportData) {
        downloadJson(result.exportData, `${deleteTarget.name}-世界设定.json`)
      }
      const kept = keepCharacters ? '，角色已移入角色库' : ''
      toast.success(`已删除世界「${deleteTarget.name}」${kept}`)
      setDeleteTarget(null)
    }
  }

  return (
    <>
      <Dialog open={open && !deleteTarget} onClose={onClose} className="max-w-2xl">
        <DialogHeader onClose={onClose}>
          <DialogTitle>世界管理</DialogTitle>
          <DialogDescription>创建、改名、导出或删除世界。每个世界独立隔离角色与记忆。</DialogDescription>
        </DialogHeader>

        {/* 新建按钮 / 新建表单 */}
        {!showCreate ? (
          <Button
            variant="outline"
            size="sm"
            className="mb-3"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="size-4" />
            新建世界
          </Button>
        ) : (
          <div className="mb-4 rounded-md border border-border bg-secondary/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">新建世界</span>
              <button
                onClick={() => setShowCreate(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="取消新建"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-2">
              <Input
                placeholder="世界名称 (如: 艾尔登大陆)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <Textarea
                placeholder="世界描述 (可选, 如: 一个剑与魔法的高魔世界)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="min-h-[60px]"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
                  取消
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={creating}>
                  {creating ? '创建中...' : '创建'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 世界列表 */}
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {worlds.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无世界，点击上方按钮创建
            </div>
          )}
          {worlds.map((w) => {
            const isActive = w.id === activeWorld?.id
            const isDefault = w.id === DEFAULT_WORLD_ID
            const isEditing = editingId === w.id
            return (
              <div
                key={w.id}
                className={cn(
                  'rounded-md border p-3 transition-colors',
                  isActive ? 'border-primary/40 bg-primary/5' : 'border-border',
                )}
              >
                {isEditing ? (
                  // 行内编辑
                  <div className="space-y-2">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <Textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="min-h-[50px]"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </Button>
                      <Button size="sm" onClick={handleSaveEdit}>
                        <Check className="size-3.5" />
                        保存
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <Globe
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{w.name}</span>
                        {isActive && <Badge variant="default">当前</Badge>}
                        {isDefault && <Badge variant="secondary">默认</Badge>}
                      </div>
                      {w.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {w.description}
                        </p>
                      )}
                    </div>
                    {/* 操作按钮 */}
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => startEdit(w)}
                        aria-label="改名"
                        title="改名 / 改描述"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => handleExport(w)}
                        aria-label="导出设定"
                        title="导出世界设定 (JSON)"
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => openDelete(w)}
                        disabled={isDefault}
                        aria-label="删除"
                        title={isDefault ? '默认世界不可删除' : '删除世界'}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 数据备份 (整库, 跨所有世界) */}
        <div className="mt-4 rounded-md border border-border p-3">
          <div className="mb-1 text-sm font-medium">数据备份</div>
          <p className="mb-2 text-xs text-muted-foreground">
            导出整个数据库（含全部世界、角色与记忆）。恢复需重启服务后生效。
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleBackup} disabled={backupBusy}>
              <Download className="size-3.5" />
              下载备份
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => restoreRef.current?.click()}
              disabled={backupBusy}
            >
              <Upload className="size-3.5" />
              恢复备份
            </Button>
            <input
              ref={restoreRef}
              type="file"
              accept=".db,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleRestore(file)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除确认子 Dialog */}
      <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} className="max-w-md">
        <DialogHeader onClose={() => !deleting && setDeleteTarget(null)}>
          <DialogTitle>删除世界</DialogTitle>
          <DialogDescription>
            即将删除「{deleteTarget?.name}」。此操作不可撤销，请确认处理方式。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 transition-colors hover:bg-accent">
            <input
              type="checkbox"
              checked={keepCharacters}
              onChange={(e) => setKeepCharacters(e.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">保留角色到角色库</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                将该世界的角色移入角色库 (worldId 置空)，可随时导入到其他世界。取消勾选则随世界一并删除。
              </p>
            </div>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 transition-colors hover:bg-accent">
            <input
              type="checkbox"
              checked={exportSettings}
              onChange={(e) => setExportSettings(e.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">导出世界设定</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                删除前导出世界设定快照 (地点 / 连线 / Lore / 状态 / 任务) 为 JSON 文件。
              </p>
            </div>
          </label>

          {!keepCharacters && (
            <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              未保留的角色将随世界一并删除，且无法恢复。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDeleteTarget(null)}
            disabled={deleting}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirmDelete}
            disabled={deleting}
          >
            {deleting ? '删除中...' : '确认删除'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}

/** 触发浏览器下载 JSON 文件 */
function downloadJson(data: WorldExport, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
