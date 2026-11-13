import { useEffect, useRef, useState } from 'react'
import { BookOpen, Plus, Trash2, Upload } from 'lucide-react'
import type { LoreEntry } from '@worldsmith/shared'
import { api } from '../lib/api'
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { Badge } from './ui/Badge'
import { toast } from './ui/Toast'
import { cn } from '../lib/utils'

// ============================================================
// LoreDialog: 世界知识 (Lorebook) 管理
// 关键词命中时由 chat/service 注入对话上下文, 按世界隔离
// 支持导入 SillyTavern 世界书 (World Info) JSON
// ============================================================

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LoreDialog({ open, onOpenChange }: Props) {
  const [entries, setEntries] = useState<LoreEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newKeys, setNewKeys] = useState('')
  const [newContent, setNewContent] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true)
    try {
      setEntries(await api.getLore())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载世界知识失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setShowCreate(false)
      load()
    }
  }, [open])

  async function handleCreate() {
    const keys = newKeys
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean)
    if (keys.length === 0 || !newContent.trim()) {
      toast.error('关键词和内容都不能为空')
      return
    }
    try {
      const row = await api.createLore({ keys, content: newContent.trim() })
      setEntries((prev) => [row, ...prev])
      setNewKeys('')
      setNewContent('')
      setShowCreate(false)
      toast.success('已添加')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败')
    }
  }

  async function handleToggle(entry: LoreEntry) {
    try {
      const row = await api.updateLore(entry.id, { enabled: !entry.enabled })
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? row : e)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  async function handleDelete(entry: LoreEntry) {
    try {
      await api.deleteLore(entry.id)
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
      toast.success('已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function handleImportFile(file: File) {
    try {
      const json = JSON.parse(await file.text())
      const result = await api.importLore(json)
      toast.success(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    }
  }

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} className="max-w-2xl">
      <DialogHeader onClose={() => onOpenChange(false)}>
        <div className="flex items-center gap-2">
          <BookOpen className="size-5 text-primary" />
          <div>
            <DialogTitle>世界知识</DialogTitle>
            <DialogDescription>
              关键词命中时自动注入对话上下文。支持导入 SillyTavern 世界书（World Info）JSON。
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setShowCreate((v) => !v)}>
          <Plus className="size-3.5" />
          新建
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" />
          导入世界书
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleImportFile(file)
            e.target.value = ''
          }}
        />
        <span className="ml-auto text-xs text-muted-foreground">共 {entries.length} 条</span>
      </div>

      {showCreate && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <Input
            placeholder="关键词，用逗号分隔（任一命中即注入）"
            value={newKeys}
            onChange={(e) => setNewKeys(e.target.value)}
          />
          <Textarea
            className="min-h-20 text-sm"
            placeholder="设定内容"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleCreate}>
              添加
            </Button>
          </div>
        </div>
      )}

      <div className="max-h-[55vh] space-y-2 overflow-y-auto">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            尚无世界知识。可直接新建，或导入 SillyTavern 世界书。
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                'rounded-lg border border-border p-3',
                !entry.enabled && 'opacity-50',
              )}
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-1">
                {entry.keys.map((k) => (
                  <Badge key={k} variant="secondary" className="text-xs">
                    {k}
                  </Badge>
                ))}
                <span className="ml-auto text-xs text-muted-foreground">
                  优先级 {entry.priority}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">{entry.content}</p>
              <div className="mt-2 flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => handleToggle(entry)}>
                  {entry.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(entry)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </Dialog>
  )
}
