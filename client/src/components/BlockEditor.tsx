import { useState } from 'react'
import {
  ArrowDown, ArrowUp, BookOpen, Code, Layers, Plus, Trash2, X,
  Sparkles, Copy, ClipboardPaste, Check,
} from 'lucide-react'
import type { CharacterBlock, CharacterBlockField } from '@worldsmith/shared'
import { Button } from './ui/Button'
import { Card, CardContent } from './ui/Card'
import { Badge } from './ui/Badge'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { api } from '../lib/api'
import { toast } from './ui/Toast'

// ============================================================
// 角色卡板块编辑器: 拖拽排序(上下按钮) + 自定义板块
// 字段 kind: code(代码引擎计算) | narrative(注入 LLM)
// 支持自然语言编辑 + 复制/粘贴 JSON
// ============================================================

function genId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

interface Props {
  initial: CharacterBlock[]
  /** 角色 ID (自然语言编辑时需要调用后端 LLM) */
  characterId?: string
  onSave: (blocks: CharacterBlock[]) => Promise<void>
  onClose: () => void
}

export function BlockEditor({ initial, characterId, onSave, onClose }: Props) {
  const [blocks, setBlocks] = useState<CharacterBlock[]>(() =>
    [...initial].sort((a, b) => a.order - b.order),
  )
  const [saving, setSaving] = useState(false)
  // 自然语言编辑
  const [naturalOpen, setNaturalOpen] = useState(false)
  const [naturalInput, setNaturalInput] = useState('')
  const [naturalLoading, setNaturalLoading] = useState(false)
  // 复制成功反馈
  const [copied, setCopied] = useState(false)

  function updateBlock(id: string, patch: Partial<CharacterBlock>) {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }

  function updateField(blockId: string, fieldIdx: number, patch: Partial<CharacterBlockField>) {
    setBlocks((bs) =>
      bs.map((b) =>
        b.id === blockId
          ? {
              ...b,
              fields: b.fields.map((f, i) => (i === fieldIdx ? { ...f, ...patch } : f)),
            }
          : b,
      ),
    )
  }

  function moveBlock(idx: number, dir: -1 | 1) {
    setBlocks((bs) => {
      const next = [...bs]
      const target = idx + dir
      if (target < 0 || target >= next.length) return bs
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  function addBlock() {
    setBlocks((bs) => [
      ...bs,
      { id: genId(), type: 'custom', title: '新板块', fields: [], order: bs.length },
    ])
  }

  function addField(blockId: string) {
    setBlocks((bs) =>
      bs.map((b) =>
        b.id === blockId
          ? {
              ...b,
              fields: [
                ...b.fields,
                { key: `f${b.fields.length}`, label: '字段', value: '', kind: 'narrative' },
              ],
            }
          : b,
      ),
    )
  }

  async function handleSave() {
    setSaving(true)
    const ordered = blocks.map((b, i) => ({ ...b, order: i }))
    await onSave(ordered)
    setSaving(false)
  }

  // 复制 JSON 到剪贴板
  async function handleCopy() {
    const ordered = blocks.map((b, i) => ({ ...b, order: i }))
    try {
      await navigator.clipboard.writeText(JSON.stringify(ordered, null, 2))
      setCopied(true)
      toast.success('角色卡 JSON 已复制到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  // 从剪贴板粘贴 JSON
  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText()
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) {
        toast.error('剪贴板内容不是有效的角色卡 JSON（需要数组）')
        return
      }
      // 基本校验
      const valid = parsed.every(
        (b) =>
          typeof b === 'object' &&
          typeof b.id === 'string' &&
          typeof b.title === 'string' &&
          Array.isArray(b.fields),
      )
      if (!valid) {
        toast.error('JSON 格式不正确：需要 id/title/fields 字段')
        return
      }
      const ordered: CharacterBlock[] = parsed.map((b: CharacterBlock, i: number) => ({
        ...b,
        order: i,
        type: b.type || 'custom',
        fields: b.fields.map((f: CharacterBlockField, fi: number): CharacterBlockField => ({
          ...f,
          key: f.key || `f${fi}`,
          kind: f.kind === 'code' ? 'code' : 'narrative',
        })),
      }))
      setBlocks(ordered)
      toast.success(`已粘贴 ${ordered.length} 个板块`)
    } catch {
      toast.error('粘贴失败：剪贴板内容不是有效 JSON')
    }
  }

  // 自然语言编辑
  async function handleNaturalEdit() {
    if (!characterId) {
      toast.error('缺少角色 ID，无法使用自然语言编辑')
      return
    }
    if (!naturalInput.trim()) {
      toast.error('请输入修改指令')
      return
    }
    setNaturalLoading(true)
    try {
      const result = await api.editCharacterNatural(characterId, naturalInput.trim())
      const ordered = result.blocks.map((b, i) => ({ ...b, order: i }))
      setBlocks(ordered)
      toast.success('已根据指令修改角色卡，请检查后保存')
      setNaturalOpen(false)
      setNaturalInput('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '自然语言编辑失败')
    } finally {
      setNaturalLoading(false)
    }
  }

  return (
    <Card className="w-full border-primary/30">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Layers className="h-4 w-4 text-primary" />
            角色卡板块编辑器
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="复制角色卡 JSON"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="从剪贴板粘贴 JSON"
              onClick={handlePaste}
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="自然语言编辑"
              onClick={() => setNaturalOpen((v) => !v)}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* 自然语言编辑区 */}
        {naturalOpen && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 space-y-2">
            <div className="flex items-center gap-1 text-xs font-medium text-primary">
              <Sparkles className="h-3 w-3" />
              自然语言编辑
            </div>
            <Textarea
              className="min-h-[60px] text-xs"
              placeholder="用自然语言描述修改需求，如：&#10;- 把年龄改成 25 岁&#10;- 添加一个叫「技能」的板块，包含剑术（精通）和火魔法（初级）&#10;- 删除「外貌」板块&#10;- 把性格字段的内容改成「冷静、理智」"
              value={naturalInput}
              onChange={(e) => setNaturalInput(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                AI 解析后会预览修改结果，需手动保存
              </span>
              <Button
                size="sm"
                className="text-xs"
                onClick={handleNaturalEdit}
                disabled={naturalLoading || !naturalInput.trim()}
              >
                {naturalLoading ? (
                  <>
                    <Sparkles className="h-3 w-3 animate-pulse" />
                    解析中…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3" />
                    执行修改
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {blocks.length === 0 && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              还没有板块 — 点击下方"添加板块"创建，或用自然语言编辑 / 粘贴 JSON
            </p>
          )}
          {blocks.map((block, bi) => (
            <div key={block.id} className="rounded-md border border-border p-2">
              <div className="flex items-center gap-1">
                <Input
                  className="h-6 min-w-0 flex-1 px-1.5 text-xs font-medium"
                  value={block.title}
                  onChange={(e) => updateBlock(block.id, { title: e.target.value })}
                />
                <Badge variant="secondary" className="shrink-0">{block.type}</Badge>
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => moveBlock(bi, -1)}>
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => moveBlock(bi, 1)}>
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5 text-muted-foreground hover:text-destructive"
                  onClick={() => setBlocks((bs) => bs.filter((b) => b.id !== block.id))}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-1.5 space-y-1">
                {block.fields.map((field, fi) => (
                  <div key={`${block.id}-${fi}`} className="flex items-center gap-1">
                    <Input
                      className="h-6 w-16 shrink-0 px-1.5 text-xs"
                      placeholder="标签"
                      value={field.label}
                      onChange={(e) => updateField(block.id, fi, { label: e.target.value })}
                    />
                    <Input
                      className="h-6 min-w-0 flex-1 px-1.5 text-xs"
                      placeholder="内容"
                      value={field.value}
                      onChange={(e) => updateField(block.id, fi, { value: e.target.value })}
                    />
                    <Badge
                      role="button"
                      tabIndex={0}
                      variant={field.kind === 'code' ? 'outline' : 'default'}
                      className="h-5 shrink-0 cursor-pointer gap-1 px-1.5 text-xs"
                      title="code=代码引擎字段(不注入LLM) / narrative=叙事字段(注入LLM)"
                      onClick={() =>
                        updateField(block.id, fi, {
                          kind: field.kind === 'code' ? 'narrative' : 'code',
                        })
                      }
                    >
                      {field.kind === 'code' ? (
                        <Code className="h-3 w-3" />
                      ) : (
                        <BookOpen className="h-3 w-3" />
                      )}
                      {field.kind === 'code' ? '代码' : '叙事'}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        updateBlock(block.id, {
                          fields: block.fields.filter((_, i) => i !== fi),
                        })
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="h-5 text-xs" onClick={() => addField(block.id)}>
                  <Plus className="h-3 w-3" /> 添加字段
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={addBlock}>
            <Plus className="h-3 w-3" /> 添加板块
          </Button>
        </div>

        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存角色卡'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
