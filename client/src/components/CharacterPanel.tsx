import { useState, useMemo } from 'react'
import {
  Plus, Trash2, Pencil, Sparkles, Upload, Download, Users, Swords,
  MapPin, Clock, Heart, Backpack, RefreshCw, Check, Archive,
  Activity, Coins, Swords as Sword, Shield, Star, Zap, Brain, User, Info,
  type LucideIcon,
} from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Button } from './ui/Button'
import { Card, CardContent } from './ui/Card'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/Dialog'
import { toast } from './ui/Toast'
import { cn } from '../lib/utils'
import { api } from '../lib/api'
import { colorForName } from '../lib/character-color'
import { BlockEditor } from './BlockEditor'
import { RpgStateBar, RPG_PRESETS } from './RpgStateBar'
import type { CharacterBlock, CharacterState } from '@worldsmith/shared'

interface TraitSuggestion {
  trait: string
  count: number
  currentPersonality: string
  gmText: string
}

// 状态栏 icon 映射 (lucide 图标名 → 组件)
const STATE_ICON_MAP: Record<string, LucideIcon> = {
  MapPin, Clock, Heart, Backpack, Activity, Coins,
  Sword, Shield, Star, Zap, Brain,
}

export function CharacterPanel() {
  const {
    characters, activeCharacter, loadCharacters, selectCharacter,
    createCharacter, deleteCharacter, updateCharacter,
    createGroupConversation, createAdventureConversation, streaming,
    playerStates, loadPlayerStates, upsertPlayerState, deletePlayerState,
    characterStates, loadCharacterStates, upsertCharacterState, deleteCharacterState,
    detachCharacterToLibrary,
  } = useAppStore()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [groupSelecting, setGroupSelecting] = useState(false)
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', personality: '', background: '', firstMessage: '' })
  const [suggestion, setSuggestion] = useState<TraitSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState('')

  // 角色详情查看弹窗 (可编辑: 基础字段 + 板块)
  const [detailCharacter, setDetailCharacter] = useState<typeof characters[number] | null>(null)
  // 详情弹窗的编辑草稿 (含基础字段, blocks 由 BlockEditor 自管理)
  const [detailDraft, setDetailDraft] = useState<{
    name: string
    personality: string
    background: string
    appearance: string
    scenario: string
    firstMessage: string
    tags: string
  } | null>(null)
  const [detailSaving, setDetailSaving] = useState(false)

  // 状态栏管理: 选中的角色 (用于角色动态状态管理, 默认当前活跃角色)
  const [selectedCharId, setSelectedCharId] = useState<string>('')

  // 状态栏总览弹窗 + 单项编辑弹窗 (支持玩家状态 / 角色状态两种 scope)
  const [stateOverviewOpen, setStateOverviewOpen] = useState(false)
  // 状态栏管理弹窗的 Tab (player = 玩家状态, character = 角色动态状态)
  const [stateTab, setStateTab] = useState<'player' | 'character'>('player')
  const [stateDialog, setStateDialog] = useState<{
    mode: 'edit' | 'create'
    /** player = 玩家状态栏, character = 角色动态状态 */
    scope: 'player' | 'character'
    /** scope=character 时必填 */
    characterId?: string
    /** 显示用角色名 */
    characterName?: string
    key: string
    label: string
    value: string
    icon: string
  } | null>(null)

  // 角色状态按 characterId 分组 (用于总览弹窗展示)
  const characterStateGroups = useMemo(() => {
    const groups = new Map<string, { character: typeof characters[number] | null; states: CharacterState[] }>()
    for (const cs of characterStates) {
      if (!groups.has(cs.characterId)) {
        const character = characters.find((c) => c.id === cs.characterId) ?? null
        groups.set(cs.characterId, { character, states: [] })
      }
      groups.get(cs.characterId)!.states.push(cs)
    }
    return Array.from(groups.entries())
  }, [characterStates, characters])

  // 状态栏管理弹窗中选中的角色状态列表
  const selectedCharStates = useMemo(() => {
    if (!selectedCharId) return []
    return characterStates.filter((cs) => cs.characterId === selectedCharId)
  }, [characterStates, selectedCharId])

  // 选中的角色对象
  const selectedCharObj = useMemo(
    () => characters.find((c) => c.id === selectedCharId) ?? null,
    [characters, selectedCharId],
  )

  async function handleSuggest() {
    if (!activeCharacter) return
    setSuggesting(true)
    setSuggestError('')
    try {
      const data = await api.suggestTrait(activeCharacter.id)
      if (data.suggestion) setSuggestion(data.suggestion)
      else {
        const reason = data.reason ?? '无可用建议'
        setSuggestError(reason)
        toast.error(reason)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSuggestError(msg)
      toast.error(msg)
    } finally {
      setSuggesting(false)
    }
  }

  async function handleAdopt() {
    if (!activeCharacter || !suggestion) return
    const current = (activeCharacter.personality || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!current.includes(suggestion.trait)) current.push(suggestion.trait)
    await updateCharacter(activeCharacter.id, { personality: current.join(',') })
    setSuggestion(null)
    toast.success('已并入性格锚点')
  }

  async function handleCreate() {
    if (!form.name.trim()) return
    await createCharacter({
      name: form.name.trim(),
      personality: form.personality.trim(),
      background: form.background.trim(),
      firstMessage: form.firstMessage.trim() || undefined,
    })
    setForm({ name: '', personality: '', background: '', firstMessage: '' })
    setCreating(false)
    toast.success('角色已创建')
  }

  const deletingCharacter = characters.find((c) => c.id === deletingId) ?? null

  async function handleConfirmDelete() {
    if (!deletingId) return
    const id = deletingId
    setDeletingId(null)
    await deleteCharacter(id)
    toast.success('角色已删除')
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">角色</h2>
        <div className="flex gap-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/png"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = async () => {
                  const base64Png = String(reader.result).split(',')[1]
                  try {
                    // 走 api 层: 自动带 x-world-id, 否则角色会落到默认世界
                    await api.importCharacterCard(base64Png)
                    await loadCharacters()
                    toast.success('角色卡已导入')
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : '角色卡导入失败')
                  }
                }
                reader.readAsDataURL(file)
                e.target.value = ''
              }}
            />
            <Button size="sm" variant="outline" className="h-7" title="导入 PNG 角色卡">
              <Upload className="h-3.5 w-3.5" />
            </Button>
          </label>
          {activeCharacter && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              title={`导出 ${activeCharacter.name} 为 PNG 角色卡`}
              onClick={async () => {
                try {
                  const blob = await api.exportCharacterCard(activeCharacter.id)
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${activeCharacter.name}.png`
                  a.click()
                  URL.revokeObjectURL(url)
                  toast.success('角色卡已导出')
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : '角色卡导出失败')
                }
              }}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> 新建
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            title="创建群聊（多角色同场景）"
            onClick={() => {
              setGroupSelecting(true)
              setCreating(false)
            }}
          >
            <Users className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 新建角色 Dialog */}
      <Dialog open={creating} onClose={() => setCreating(false)}>
        <DialogHeader onClose={() => setCreating(false)}>
          <DialogTitle>新建角色</DialogTitle>
          <DialogDescription>填写角色基础设定，标 * 为必填项</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            placeholder="名称 *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder="人格锚点 (逗号分隔)"
            value={form.personality}
            onChange={(e) => setForm({ ...form, personality: e.target.value })}
          />
          <Textarea
            className="min-h-[64px]"
            placeholder="背景故事"
            value={form.background}
            onChange={(e) => setForm({ ...form, background: e.target.value })}
          />
          <Textarea
            className="min-h-[48px]"
            placeholder="开场白 (角色的第一句话)"
            value={form.firstMessage}
            onChange={(e) => setForm({ ...form, firstMessage: e.target.value })}
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>取消</Button>
          <Button size="sm" onClick={handleCreate} disabled={!form.name.trim()}>创建</Button>
        </DialogFooter>
      </Dialog>

      {/* 创建群聊 Dialog */}
      <Dialog
        open={groupSelecting}
        onClose={() => { setGroupSelecting(false); setGroupIds([]) }}
      >
        <DialogHeader onClose={() => { setGroupSelecting(false); setGroupIds([]) }}>
          <DialogTitle>创建群聊</DialogTitle>
          <DialogDescription>选择 2-4 个角色进入同一场景</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {characters.map((c) => {
            const checked = groupIds.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setGroupIds((ids) =>
                    checked ? ids.filter((i) => i !== c.id) : [...ids, c.id],
                  )
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                  checked
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-foreground hover:bg-secondary',
                )}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {checked && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            )
          })}
          {characters.length < 2 && (
            <p className="text-xs text-muted-foreground">至少需要 2 个角色</p>
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setGroupSelecting(false); setGroupIds([]) }}
          >
            取消
          </Button>
          <Button
            size="sm"
            disabled={groupIds.length < 2}
            onClick={async () => {
              await createGroupConversation(groupIds)
              setGroupSelecting(false)
              setGroupIds([])
              toast.success('群聊已创建')
            }}
          >
            开始群聊
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog open={deletingId !== null} onClose={() => setDeletingId(null)}>
        <DialogHeader onClose={() => setDeletingId(null)}>
          <DialogTitle>删除角色</DialogTitle>
          <DialogDescription>
            {deletingCharacter
              ? `将删除角色 “${deletingCharacter.name}”，其所有对话将一并删除。此操作不可撤销。`
              : '确认删除此角色？此操作不可撤销。'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => setDeletingId(null)}>取消</Button>
          <Button size="sm" variant="destructive" onClick={handleConfirmDelete}>删除</Button>
        </DialogFooter>
      </Dialog>

      <div className="flex flex-col gap-2">
        {characters.length === 0 && !creating && (
          <p className="px-1 text-xs text-muted-foreground">还没有角色，点击“新建”创建第一个。</p>
        )}
        {characters.map((c) => (
          <Card
            key={c.id}
            className={cn(
              'cursor-pointer transition-colors hover:border-primary/50',
              activeCharacter?.id === c.id && 'border-primary',
            )}
            onClick={() => !streaming && selectCharacter(c.id)}
          >
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  {c.avatar ? (
                    <img
                      src={c.avatar}
                      alt={c.name}
                      className="h-8 w-8 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white',
                        colorForName(c.name).bg,
                      )}
                    >
                      {c.name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {c.personality || c.background || '（无设定）'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                    title={`查看 / 编辑 ${c.name} 的完整设定`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDetailCharacter(c)
                      setDetailDraft({
                        name: c.name,
                        personality: c.personality || '',
                        background: c.background || '',
                        appearance: c.appearance || '',
                        scenario: c.scenario || '',
                        firstMessage: c.firstMessage || '',
                        tags: (c.tags || []).join(', '),
                      })
                    }}
                  >
                    <Info className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                    title={`以 ${c.name} 为玩家角色开始文字冒险`}
                    onClick={(e) => {
                      e.stopPropagation()
                      createAdventureConversation(c.id)
                    }}
                  >
                    <Swords className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(editingId === c.id ? null : c.id)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                    title={`将「${c.name}」移入角色库（可从角色库面板导入到任意世界）`}
                    onClick={async (e) => {
                      e.stopPropagation()
                      await detachCharacterToLibrary(c.id)
                    }}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeletingId(c.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {editingId === c.id && (
                <div className="mt-2">
                  <BlockEditor
                    initial={c.blocks ?? []}
                    characterId={c.id}
                    onSave={async (blocks: CharacterBlock[]) => {
                      await updateCharacter(c.id, { blocks })
                      setEditingId(null)
                    }}
                    onClose={() => setEditingId(null)}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-auto space-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        {/* 性格演变提议 */}
        {activeCharacter && (
          <>
            <Button size="sm" variant="outline" className="w-full text-xs" onClick={handleSuggest} disabled={suggesting}>
              <Sparkles className="h-3 w-3" />
              {suggesting ? '分析中…' : '性格演变分析'}
            </Button>
            {suggestError && <p className="text-xs text-muted-foreground/70">{suggestError}</p>}
            {suggestion && (
              <Card className="border-primary/40">
                <CardContent className="space-y-1.5 p-2.5">
                  <div className="text-xs font-medium text-primary">
                    GM 提议：“{suggestion.trait}” ({suggestion.count} 次表现)
                  </div>
                  <p className="text-xs leading-relaxed">{suggestion.gmText}</p>
                  <p className="text-xs text-muted-foreground/70">
                    当前锚点: {suggestion.currentPersonality || '（空）'}
                  </p>
                  <div className="flex gap-1.5">
                    <Button size="sm" className="h-6 flex-1 text-xs" onClick={handleAdopt}>
                      采纳并入锚点
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSuggestion(null)}>
                      暂不
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        <div className="flex items-center justify-between">
          <button
            className="inline-flex items-center gap-1 font-medium transition-colors hover:text-primary"
            onClick={() => {
              loadPlayerStates()
              loadCharacterStates()
              // 默认选中当前活跃角色
              if (activeCharacter && !selectedCharId) setSelectedCharId(activeCharacter.id)
              setStateOverviewOpen(true)
            }}
          >
            状态栏
            <span className="text-xs text-muted-foreground">
              ({playerStates.length + characterStates.length})
            </span>
          </button>
          <button
            className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
            onClick={() => { loadPlayerStates(); loadCharacterStates(); loadCharacters() }}
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </button>
        </div>
        {playerStates.length > 0 || characterStates.length > 0 ? (
          <div className="mt-2 space-y-2">
            {/* 玩家状态 — RPG 进度条 */}
            {playerStates.length > 0 && (
              <div className="space-y-1">
                {playerStates.map((s) => (
                  <button
                    key={s.id}
                    className="block w-full rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary"
                    title="点击查看全部状态"
                    onClick={() => { loadPlayerStates(); loadCharacterStates(); setStateOverviewOpen(true) }}
                  >
                    <RpgStateBar state={s} compact />
                  </button>
                ))}
              </div>
            )}
            {/* 角色动态状态 (按角色分组, RPG 进度条) */}
            {characterStateGroups.length > 0 && (
              <div className="space-y-1.5 border-t border-border/50 pt-1.5">
                {characterStateGroups.map(([charId, group]) => (
                  <div key={charId} className="space-y-1">
                    <p className="truncate px-1 text-xs font-medium text-foreground/70">
                      {group.character?.name ?? '未知角色'}
                    </p>
                    <div className="space-y-1">
                      {group.states.map((s) => (
                        <button
                          key={s.id}
                          className="block w-full rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary"
                          title="点击查看全部状态"
                          onClick={() => { loadPlayerStates(); loadCharacterStates(); setStateOverviewOpen(true) }}
                        >
                          <RpgStateBar state={s} compact />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            className="mt-2 text-xs text-muted-foreground/60 hover:text-primary"
            onClick={() => setStateOverviewOpen(true)}
          >
            暂无状态项 — 点击打开管理
          </button>
        )}
      </div>

      {/* 状态栏总览弹窗 */}
      <Dialog
        open={stateOverviewOpen}
        onClose={() => setStateOverviewOpen(false)}
        className="max-w-lg"
      >
        <DialogHeader onClose={() => setStateOverviewOpen(false)}>
          <DialogTitle>状态栏管理</DialogTitle>
          <DialogDescription>玩家状态 + 角色动态状态，点击任意项编辑</DialogDescription>
        </DialogHeader>

        {/* Tab 切换 */}
        <div className="mb-3 flex gap-1 rounded-md bg-secondary/60 p-1">
          <button
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              stateTab === 'player'
                ? 'bg-popover text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setStateTab('player')}
          >
            玩家状态 ({playerStates.length})
          </button>
          <button
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              stateTab === 'character'
                ? 'bg-popover text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setStateTab('character')}
          >
            角色状态 ({characterStates.length})
          </button>
        </div>

        <div className="max-h-80 space-y-3 overflow-y-auto">
          {stateTab === 'player' ? (
            /* 玩家状态分区 */
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <User className="h-3 w-3" />
                  玩家状态
                </span>
                <div className="flex gap-1">
                  {/* RPG 预设下拉 */}
                  <div className="relative group">
                    <button className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
                      <Sparkles className="h-3 w-3" />RPG 预设
                    </button>
                    <div className="absolute right-0 top-full z-10 hidden group-hover:block w-40 rounded-md border border-border bg-popover p-1 shadow-md">
                      {RPG_PRESETS.map((preset) => (
                        <button
                          key={preset.name}
                          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
                          onClick={async () => {
                            for (const s of preset.states) {
                              await upsertPlayerState(s)
                            }
                            await loadPlayerStates()
                            toast.success(`已添加「${preset.name}」预设`)
                          }}
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary"
                    onClick={() => setStateDialog({ mode: 'create', scope: 'player', key: '', label: '', value: '', icon: 'Activity' })}
                  >
                    <Plus className="h-3 w-3" />添加
                  </button>
                </div>
              </div>
              {playerStates.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground/60">暂无玩家状态</p>
              ) : (
                <div className="space-y-1">
                  {playerStates.map((s) => (
                    <button
                      key={s.id}
                      className="block w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-secondary"
                      onClick={() => setStateDialog({ mode: 'edit', scope: 'player', key: s.key, label: s.label, value: s.value, icon: s.icon })}
                    >
                      <RpgStateBar state={s} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* 角色动态状态分区 (可选择角色, 与玩家状态体验一致) */
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Users className="h-3 w-3" />
                  角色动态状态
                </span>
                {selectedCharId && (
                  <div className="flex gap-1">
                    {/* RPG 预设下拉 — 与玩家状态一致 */}
                    <div className="relative group">
                      <button className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
                        <Sparkles className="h-3 w-3" />RPG 预设
                      </button>
                      <div className="absolute right-0 top-full z-10 hidden w-40 rounded-md border border-border bg-popover p-1 shadow-md group-hover:block">
                        {RPG_PRESETS.map((preset) => (
                          <button
                            key={preset.name}
                            className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
                            onClick={async () => {
                              if (!selectedCharId) return
                              for (const s of preset.states) {
                                await upsertCharacterState(selectedCharId, {
                                  key: s.key,
                                  value: s.value,
                                  label: s.label,
                                  icon: s.icon,
                                })
                              }
                              await loadCharacterStates()
                              toast.success(`已为「${selectedCharObj?.name}」添加「${preset.name}」预设`)
                            }}
                          >
                            {preset.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary"
                      onClick={() => setStateDialog({
                        mode: 'create',
                        scope: 'character',
                        characterId: selectedCharId,
                        characterName: selectedCharObj?.name,
                        key: '', label: '', value: '', icon: 'Activity',
                      })}
                    >
                      <Plus className="h-3 w-3" />添加
                    </button>
                  </div>
                )}
              </div>

              {/* 角色选择器 — 显示头像+名字+状态数, 更直观 */}
              <div className="flex flex-wrap gap-1">
                {characters.map((c) => {
                  const count = characterStates.filter((cs) => cs.characterId === c.id).length
                  const isActive = selectedCharId === c.id
                  return (
                    <button
                      key={c.id}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                        isActive
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-secondary',
                      )}
                      onClick={() => setSelectedCharId(c.id)}
                    >
                      {c.avatar ? (
                        <img src={c.avatar} alt="" className="h-4 w-4 rounded-full object-cover" />
                      ) : (
                        <div
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-white',
                            colorForName(c.name).bg,
                          )}
                        >
                          {c.name.charAt(0)}
                        </div>
                      )}
                      {c.name}
                      <span className={cn(
                        'rounded px-1 text-[10px]',
                        count > 0 ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground',
                      )}>
                        {count}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 选中角色的状态列表 */}
              {selectedCharId ? (
                selectedCharStates.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground/60">
                    「{selectedCharObj?.name ?? '未知角色'}」暂无动态状态
                  </p>
                ) : (
                  <div className="space-y-1">
                    {selectedCharStates.map((s) => (
                      <button
                        key={s.id}
                        className="block w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-secondary"
                        onClick={() => setStateDialog({
                          mode: 'edit',
                          scope: 'character',
                          characterId: selectedCharId,
                          characterName: selectedCharObj?.name,
                          key: s.key, label: s.label, value: s.value, icon: s.icon,
                        })}
                      >
                        <RpgStateBar state={s} />
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <p className="py-3 text-center text-xs text-muted-foreground/60">
                  选择一个角色以管理其动态状态
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            onClick={() => { loadPlayerStates(); loadCharacterStates(); loadCharacters() }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setStateOverviewOpen(false)}>
            关闭
          </Button>
          {stateTab === 'player' ? (
            <Button
              size="sm"
              onClick={() => setStateDialog({ mode: 'create', scope: 'player', key: '', label: '', value: '', icon: 'Activity' })}
            >
              <Plus className="h-3.5 w-3.5" />
              添加玩家状态
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!selectedCharId}
              onClick={() => {
                if (selectedCharId) {
                  setStateDialog({
                    mode: 'create',
                    scope: 'character',
                    characterId: selectedCharId,
                    characterName: selectedCharObj?.name,
                    key: '', label: '', value: '', icon: 'Activity',
                  })
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              为该角色添加
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* 状态栏单项编辑弹窗 */}
      <Dialog
        open={stateDialog !== null}
        onClose={() => setStateDialog(null)}
        className="max-w-md"
      >
        {stateDialog && (
          <>
            <DialogHeader onClose={() => setStateDialog(null)}>
              <DialogTitle>
                {stateDialog.mode === 'create' ? '添加状态项' : '编辑状态项'}
                {stateDialog.scope === 'character' && stateDialog.characterName && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    · {stateDialog.characterName}
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-secondary">
                  {(() => {
                    const IconComp = STATE_ICON_MAP[stateDialog.icon] ?? Activity
                    return <IconComp className="h-4 w-4 text-primary" />
                  })()}
                </div>
                <Input
                  className="flex-1"
                  placeholder="标签（如 HP、位置、金币）"
                  value={stateDialog.label}
                  onChange={(e) => setStateDialog({ ...stateDialog, label: e.target.value })}
                />
              </div>
              <Input
                placeholder="键名（英文，如 hp、location、gold）"
                value={stateDialog.key}
                disabled={stateDialog.mode !== 'create'}
                onChange={(e) => setStateDialog({ ...stateDialog, key: e.target.value })}
              />
              <Textarea
                className="min-h-20 resize-none"
                placeholder="值（如 85、酒馆、100金币）"
                value={stateDialog.value}
                onChange={(e) => setStateDialog({ ...stateDialog, value: e.target.value })}
              />
              <div>
                <p className="mb-1 text-xs text-muted-foreground">图标</p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(STATE_ICON_MAP).map(([name, Comp]) => (
                    <button
                      key={name}
                      type="button"
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded border transition-colors',
                        stateDialog.icon === name
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-secondary',
                      )}
                      onClick={() => setStateDialog({ ...stateDialog, icon: name })}
                    >
                      <Comp className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              {stateDialog.mode === 'edit' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mr-auto text-destructive hover:text-destructive"
                  onClick={async () => {
                    if (stateDialog.scope === 'character' && stateDialog.characterId) {
                      await deleteCharacterState(stateDialog.characterId, stateDialog.key)
                    } else {
                      await deletePlayerState(stateDialog.key)
                    }
                    toast.success('状态项已删除')
                    setStateDialog(null)
                    await loadPlayerStates()
                    await loadCharacterStates()
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setStateDialog(null)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={!stateDialog.label.trim() || (stateDialog.mode === 'create' && !stateDialog.key.trim())}
                onClick={async () => {
                  const key = stateDialog.key.trim() || stateDialog.label.trim()
                  if (stateDialog.scope === 'character' && stateDialog.characterId) {
                    await upsertCharacterState(stateDialog.characterId, {
                      key,
                      value: stateDialog.value,
                      label: stateDialog.label.trim(),
                      icon: stateDialog.icon,
                    })
                  } else {
                    await upsertPlayerState({
                      key,
                      value: stateDialog.value,
                      label: stateDialog.label.trim(),
                      icon: stateDialog.icon,
                    })
                  }
                  toast.success(stateDialog.mode === 'create' ? '状态项已添加' : '状态项已更新')
                  setStateDialog(null)
                  await loadPlayerStates()
                  await loadCharacterStates()
                }}
              >
                <Check className="h-3.5 w-3.5" />
                {stateDialog.mode === 'create' ? '添加' : '保存'}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>

      {/* 角色详情编辑弹窗 (基础字段 + 板块一体化编辑) */}
      <Dialog
        open={detailCharacter !== null}
        onClose={() => { setDetailCharacter(null); setDetailDraft(null) }}
        className="max-w-2xl"
      >
        {detailCharacter && detailDraft && (
          <>
            <DialogHeader onClose={() => { setDetailCharacter(null); setDetailDraft(null) }}>
              <DialogTitle className="flex items-center gap-2">
                {detailCharacter.avatar ? (
                  <img
                    src={detailCharacter.avatar}
                    alt=""
                    className="h-8 w-8 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white',
                      colorForName(detailCharacter.name).bg,
                    )}
                  >
                    {detailCharacter.name.charAt(0)}
                  </div>
                )}
                <Input
                  className="h-7 min-w-0 flex-1 px-2 text-sm font-semibold"
                  value={detailDraft.name}
                  onChange={(e) => setDetailDraft({ ...detailDraft, name: e.target.value })}
                />
              </DialogTitle>
              <DialogDescription>角色完整设定 — 所有字段可直接编辑，保存后生效</DialogDescription>
            </DialogHeader>

            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {/* 基础字段编辑区 */}
              <div className="space-y-2">
                <div>
                  <div className="mb-0.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Brain className="h-3 w-3" />人格锚点
                  </div>
                  <Textarea
                    className="min-h-[40px] text-sm"
                    placeholder="逗号分隔的性格特征，如：冷静, 理智, 善良"
                    value={detailDraft.personality}
                    onChange={(e) => setDetailDraft({ ...detailDraft, personality: e.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">背景故事</div>
                  <Textarea
                    className="min-h-[80px] text-sm"
                    placeholder="角色的过往经历..."
                    value={detailDraft.background}
                    onChange={(e) => setDetailDraft({ ...detailDraft, background: e.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">外貌</div>
                  <Textarea
                    className="min-h-[60px] text-sm"
                    placeholder="外貌描述..."
                    value={detailDraft.appearance}
                    onChange={(e) => setDetailDraft({ ...detailDraft, appearance: e.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">场景 (文字冒险开场)</div>
                  <Textarea
                    className="min-h-[60px] text-sm"
                    placeholder="冒险模式的开场场景描述..."
                    value={detailDraft.scenario}
                    onChange={(e) => setDetailDraft({ ...detailDraft, scenario: e.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">开场白 (角色扮演首条消息)</div>
                  <Textarea
                    className="min-h-[60px] text-sm"
                    placeholder="角色的第一句话..."
                    value={detailDraft.firstMessage}
                    onChange={(e) => setDetailDraft({ ...detailDraft, firstMessage: e.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">标签 (逗号分隔)</div>
                  <Input
                    className="text-sm"
                    placeholder="如：精灵, 法师, 女性"
                    value={detailDraft.tags}
                    onChange={(e) => setDetailDraft({ ...detailDraft, tags: e.target.value })}
                  />
                </div>
              </div>

              {/* 板块化角色卡 (内嵌 BlockEditor) */}
              <div className="border-t border-border pt-2">
                <BlockEditor
                  initial={detailCharacter.blocks ?? []}
                  characterId={detailCharacter.id}
                  onSave={async (blocks: CharacterBlock[]) => {
                    await updateCharacter(detailCharacter.id, { blocks })
                  }}
                  onClose={() => { /* 嵌入式: 不关闭整个弹窗 */ }}
                />
              </div>

              {/* 动态状态 (只读, 用状态栏管理编辑) — RPG 进度条 */}
              {characterStates.filter((cs) => cs.characterId === detailCharacter.id).length > 0 && (
                <div className="space-y-1.5 border-t border-border pt-2">
                  <div className="text-xs font-medium text-muted-foreground">动态状态 (在状态栏管理中编辑)</div>
                  <div className="space-y-1.5">
                    {characterStates
                      .filter((cs) => cs.characterId === detailCharacter.id)
                      .map((cs) => (
                        <RpgStateBar key={cs.id} state={cs} />
                      ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => { setDetailCharacter(null); setDetailDraft(null) }}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={detailSaving || !detailDraft.name.trim()}
                onClick={async () => {
                  setDetailSaving(true)
                  try {
                    const tags = detailDraft.tags
                      .split(',').map((t) => t.trim()).filter(Boolean)
                    await updateCharacter(detailCharacter.id, {
                      name: detailDraft.name.trim(),
                      personality: detailDraft.personality.trim(),
                      background: detailDraft.background.trim(),
                      appearance: detailDraft.appearance.trim() || null,
                      scenario: detailDraft.scenario.trim() || null,
                      firstMessage: detailDraft.firstMessage.trim() || null,
                      tags,
                    })
                    toast.success('角色设定已保存')
                    setDetailCharacter(null)
                    setDetailDraft(null)
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : '保存失败')
                  } finally {
                    setDetailSaving(false)
                  }
                }}
              >
                <Check className="h-3.5 w-3.5" />
                {detailSaving ? '保存中…' : '保存基础字段'}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  )
}
