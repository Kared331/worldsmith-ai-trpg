import { useEffect, useState } from 'react'
import { ScrollText, Plus, Pencil, Trash2, Check, X, Bot, User } from 'lucide-react'
import type { WorldRule, WorldRuleCategory } from '@worldsmith/shared'
import { useAppStore } from '../store/appStore'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { Badge } from './ui/Badge'
import { cn } from '../lib/utils'

// ============================================================
// WorldRulesDialog: 世界规则编辑器
// GM agent 和玩家都可编写规则, 按世界隔离
// 规则注入到所有对话的 system prompt, 角色和 GM 必须遵守
// ============================================================

const CATEGORIES: Array<{ value: WorldRuleCategory; label: string }> = [
  { value: 'system', label: '系统' },
  { value: 'combat', label: '战斗' },
  { value: 'magic', label: '魔法' },
  { value: 'world', label: '世界' },
  { value: 'other', label: '其他' },
]

const CATEGORY_LABEL: Record<WorldRuleCategory, string> = {
  system: '系统',
  combat: '战斗',
  magic: '魔法',
  world: '世界',
  other: '其他',
}

export function WorldRulesDialog() {
  const open = useAppStore((s) => s.rulesDialogOpen)
  const setOpen = useAppStore((s) => s.setRulesDialogOpen)
  const rules = useAppStore((s) => s.worldRules)
  const createRule = useAppStore((s) => s.createWorldRule)
  const updateRule = useAppStore((s) => s.updateWorldRule)
  const deleteRule = useAppStore((s) => s.deleteWorldRule)
  const loadWorldRules = useAppStore((s) => s.loadWorldRules)

  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState<WorldRuleCategory>('other')

  // 行内编辑状态
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<WorldRuleCategory>('other')

  // 打开时重新加载 (确保看到 GM agent 通过 skill 创建的最新规则)
  useEffect(() => {
    if (open) {
      setShowCreate(false)
      setEditingId(null)
      loadWorldRules()
    }
  }, [open, loadWorldRules])

  function resetCreate() {
    setNewTitle('')
    setNewContent('')
    setNewCategory('other')
    setShowCreate(false)
  }

  async function handleCreate() {
    if (!newTitle.trim() || !newContent.trim()) return
    await createRule({
      title: newTitle.trim(),
      content: newContent.trim(),
      category: newCategory,
    })
    resetCreate()
  }

  function startEdit(rule: WorldRule) {
    setEditingId(rule.id)
    setEditTitle(rule.title)
    setEditContent(rule.content)
    setEditCategory(rule.category)
  }

  async function handleSaveEdit(id: string) {
    if (!editTitle.trim() || !editContent.trim()) return
    await updateRule(id, {
      title: editTitle.trim(),
      content: editContent.trim(),
      category: editCategory,
    })
    setEditingId(null)
  }

  async function handleToggleEnabled(rule: WorldRule) {
    await updateRule(rule.id, { enabled: !rule.enabled })
  }

  async function handleDelete(id: string) {
    await deleteRule(id)
  }

  return (
    <Dialog open={open} onClose={() => setOpen(false)} className="max-w-2xl">
      <DialogHeader onClose={() => setOpen(false)}>
        <div className="flex items-center gap-2">
          <ScrollText className="size-5 text-primary" />
          <div>
            <DialogTitle>世界规则</DialogTitle>
            <DialogDescription>
              设定当前世界的规则约束，GM 和角色都必须遵守。按世界隔离，GM agent 也可通过 skill 编写。
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="space-y-3">
        {/* 创建按钮 / 表单 */}
        {!showCreate ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="size-3.5" /> 添加规则
          </Button>
        ) : (
          <div className="space-y-2.5 rounded-md border border-border bg-secondary/30 p-3">
            <div className="flex gap-2">
              <Input
                placeholder="规则标题（如：魔法系统、战斗规则）"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={100}
                className="flex-1"
              />
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as WorldRuleCategory)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <Textarea
              placeholder="规则详细内容…"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              rows={4}
              maxLength={20000}
            />
            <p className="text-right text-xs text-muted-foreground/60">
              {newContent.length}/20000
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={resetCreate}>
                取消
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={!newTitle.trim() || !newContent.trim()}>
                创建
              </Button>
            </div>
          </div>
        )}

        {/* 规则列表 */}
        {rules.length === 0 && !showCreate ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            当前世界还没有规则。点击上方"添加规则"开始设定。
          </p>
        ) : (
          <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1">
            {rules.map((rule) => {
              const isEditing = editingId === rule.id
              return (
                <div
                  key={rule.id}
                  className={cn(
                    'rounded-md border border-border p-3 transition-opacity',
                    !rule.enabled && 'opacity-50',
                  )}
                >
                  {isEditing ? (
                    <div className="space-y-2.5">
                      <div className="flex gap-2">
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          maxLength={100}
                          className="flex-1"
                        />
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value as WorldRuleCategory)}
                          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={4}
                        maxLength={20000}
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          取消
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSaveEdit(rule.id)}
                          disabled={!editTitle.trim() || !editContent.trim()}
                        >
                          保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{rule.title}</span>
                            <Badge variant="outline" className="text-[10px]">
                              {CATEGORY_LABEL[rule.category]}
                            </Badge>
                            <Badge
                              variant={rule.author === 'gm' ? 'default' : 'secondary'}
                              className="gap-1 text-[10px]"
                            >
                              {rule.author === 'gm' ? (
                                <>
                                  <Bot className="size-2.5" /> GM
                                </>
                              ) : (
                                <>
                                  <User className="size-2.5" /> 玩家
                                </>
                              )}
                            </Badge>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                            {rule.content}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => handleToggleEnabled(rule)}
                            title={rule.enabled ? '禁用' : '启用'}
                          >
                            {rule.enabled ? (
                              <Check className="size-3.5 text-primary" />
                            ) : (
                              <X className="size-3.5 text-muted-foreground" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => startEdit(rule)}
                            title="编辑"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 hover:text-destructive"
                            onClick={() => handleDelete(rule.id)}
                            title="删除"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <p className="rounded-md bg-secondary/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
          规则会注入到当前世界所有对话的 system prompt。GM agent 可通过
          <code className="mx-1 rounded bg-background px-1 py-0.5 text-[10px]">create_world_rule</code>
          skill 自动编写规则。切换世界时规则不共享。
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>
          完成
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
