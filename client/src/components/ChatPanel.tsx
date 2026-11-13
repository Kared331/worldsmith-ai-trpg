import { useEffect, useRef, useState } from 'react'
import { Send, Users, MessageSquare, Dices, LogOut, ChevronDown, Check, Bot, Pencil, Trash2, RefreshCw, GitBranch } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/Dialog'
import { toast } from './ui/Toast'
import { MessageContent } from './MessageContent'
import { cn } from '../lib/utils'

type ConvMode = 'chat' | 'adventure' | 'group'

const MODE_OPTIONS: Array<{ value: ConvMode; label: string; desc: string }> = [
  { value: 'chat', label: '角色扮演', desc: '与角色 1 对 1 对话' },
  { value: 'adventure', label: '文字冒险', desc: '角色为玩家引导冒险叙事' },
  { value: 'group', label: '群聊剧场', desc: '多角色同场景群聊' },
]

// 角色头像色板 + 流式光标 — 共享自 character-color 模块
import { colorForName } from '../lib/character-color'

// 流式打字机光标 (竖线闪烁, 比 ▌ 字符更流畅)
function StreamingCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-primary align-middle" />
  )
}

export function ChatPanel() {
  const {
    activeCharacter,
    activeConversation,
    messages,
    streaming,
    streamError,
    sendMessage,
    refreshMessages,
    regenerateMessage,
    editMessage,
    deleteMessage,
    forkFromMessage,
    exitConversation,
    characters,
    switchConversationMode,
    renameConversation,
    deleteConversation,
  } = useAppStore()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 模式下拉菜单
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modeMenuRef = useRef<HTMLDivElement>(null)

  // 群聊选角色对话框
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [groupIds, setGroupIds] = useState<string[]>([])

  // 重命名对话框
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  // 删除确认对话框
  const [deleteOpen, setDeleteOpen] = useState(false)

  // 消息编辑态
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  function startEdit(m: { id: string; content: string }) {
    setEditingId(m.id)
    setEditingText(m.content)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingText('')
  }

  async function saveEdit() {
    if (!editingId) return
    await editMessage(editingId, editingText)
    setEditingId(null)
    setEditingText('')
  }

  useEffect(() => {
    refreshMessages()
  }, [refreshMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming])

  useEffect(() => {
    if (streamError) toast.error(streamError)
  }, [streamError])

  // 点击外部关闭模式菜单
  useEffect(() => {
    if (!modeMenuOpen) return
    const onClick = (e: MouseEvent) => {
      if (!modeMenuRef.current?.contains(e.target as Node)) setModeMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [modeMenuOpen])

  async function handleSend() {
    const content = input.trim()
    if (!content || streaming) return
    setInput('')
    await sendMessage(content)
  }

  const currentMode = activeConversation?.mode ?? 'chat'
  const currentModeLabel = MODE_OPTIONS.find((m) => m.value === currentMode)?.label ?? '角色扮演'

  async function handlePickMode(mode: ConvMode) {
    setModeMenuOpen(false)
    if (!activeConversation || mode === currentMode) return
    if (mode === 'group') {
      // 弹出选角色对话框, 预选当前角色 (如有)
      setGroupIds(activeCharacter ? [activeCharacter.id] : [])
      setGroupPickerOpen(true)
      return
    }
    await switchConversationMode(mode)
  }

  async function handleConfirmGroup() {
    if (groupIds.length < 2) {
      toast.error('群聊至少需要 2 个角色')
      return
    }
    setGroupPickerOpen(false)
    await switchConversationMode('group', groupIds)
    setGroupIds([])
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="text-sm font-medium">
          {activeConversation?.mode === 'group' ? (
            <div className="flex items-center gap-1.5">
              <Users className="size-3.5 text-muted-foreground" />
              <span>
                群聊 · <span className="text-primary">{activeConversation.title}</span>
              </span>
            </div>
          ) : activeCharacter ? (
            <div className="flex items-center gap-2">
              {activeCharacter.avatar ? (
                <img
                  src={activeCharacter.avatar}
                  alt={activeCharacter.name}
                  className="h-6 w-6 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                  {activeCharacter.name.charAt(0)}
                </div>
              )}
              <span className="flex items-center gap-1.5">
                <MessageSquare className="size-3.5 text-muted-foreground" />
                <span>
                  与 <span className="text-primary">{activeCharacter.name}</span> 对话中
                </span>
              </span>
            </div>
          ) : (
            '选择左侧角色或创建群聊'
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 模式切换下拉菜单 */}
          <div ref={modeMenuRef} className="relative">
            <button
              type="button"
              disabled={!activeConversation || streaming}
              onClick={() => setModeMenuOpen((o) => !o)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors',
                'border border-border bg-secondary/40 text-foreground',
                'hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
                modeMenuOpen && 'bg-secondary',
              )}
              title="切换对话模式"
            >
              <span className="text-muted-foreground">模式:</span>
              <span className="font-medium text-primary">{currentModeLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
            {modeMenuOpen && activeConversation && (
              <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                {MODE_OPTIONS.map((opt) => {
                  const active = opt.value === currentMode
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handlePickMode(opt.value)}
                      className={cn(
                        'flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors',
                        active ? 'bg-primary/10' : 'hover:bg-secondary',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                          active ? 'text-primary' : 'opacity-0',
                        )}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      <span className="flex-1">
                        <span className={cn('block font-medium', active && 'text-primary')}>
                          {opt.label}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {opt.desc}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {activeConversation && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
                disabled={streaming}
                onClick={() => {
                  setRenameValue(activeConversation.title ?? '')
                  setRenameOpen(true)
                }}
                title="重命名对话"
              >
                <Pencil className="size-3.5" />
                重命名
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                disabled={streaming}
                onClick={() => setDeleteOpen(true)}
                title="删除对话"
              >
                <Trash2 className="size-3.5" />
                删除
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                disabled={streaming}
                onClick={() => {
                  exitConversation()
                  toast.success('已退出对话')
                }}
                title="退出当前对话"
              >
                <LogOut className="size-3.5" />
                退出
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {activeCharacter
              ? `和 ${activeCharacter.name} 打个招呼吧。`
              : '尚未选择角色。'}
          </div>
        )}
        {messages.map((m, idx) => {
          const isUser = m.role === 'user'
          const isNarrator = m.role === 'narrator'
          const isGmCommand = isUser && m.speakerName === '__gm_command__'
          // 双条件: 仅凭 id 判断的话, 流异常结束时占位消息会留下永不消失的光标
          const isStreaming = m.id === 'streaming' && streaming
          // 本地临时消息 (尚未落库) 不支持编辑/删除
          const canOperate = !m.id.startsWith('local-') && m.id !== 'streaming'
          const isLastAi = idx === messages.length - 1 && !isUser
          // 匹配角色头像 (群聊通过 speakerName, 单角色用 activeCharacter)
          const speakerChar =
            !isUser && !isNarrator
              ? characters.find((c) => c.name === m.speakerName) ?? activeCharacter
              : null
          const speakerColor = speakerChar?.name ? colorForName(speakerChar.name) : null
          return (
            <div
              key={m.id}
              className={cn(
                'group flex gap-2 msg-fade-in',
                isUser && !isGmCommand ? 'justify-end' : 'justify-start',
              )}
            >
              {/* 左侧头像 (非用户消息) */}
              {!isUser && !isGmCommand && (
                <div className="mt-0.5 shrink-0">
                  {isNarrator ? (
                    <div className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Dices className="size-4" />
                    </div>
                  ) : speakerChar?.avatar ? (
                    <img
                      src={speakerChar.avatar}
                      alt=""
                      className="size-8 rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white',
                        speakerColor?.bg ?? 'bg-primary',
                      )}
                    >
                      {speakerChar?.name?.charAt(0) ?? '?'}
                    </div>
                  )}
                </div>
              )}

              <div
                className={cn(
                  'max-w-[75%] whitespace-pre-wrap px-3 py-2 text-sm',
                  isGmCommand
                    ? 'rounded-lg border border-primary/30 bg-primary/5 text-foreground'
                    : isUser
                      ? 'rounded-lg bg-secondary text-secondary-foreground'
                      : isNarrator
                        ? 'rounded-lg border-l-2 border-primary bg-transparent italic text-foreground'
                        : 'rounded-lg border border-border bg-card text-card-foreground',
                )}
              >
                {isGmCommand && (
                  <div className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold not-italic text-primary">
                    <Bot className="size-3.5" />
                    对 GM 说
                  </div>
                )}
                {isNarrator && (
                  <div className="mb-1 text-xs font-semibold not-italic tracking-wide text-primary">
                    GM 叙事
                  </div>
                )}
                {!isUser && !isNarrator && speakerChar?.name && (
                  <div className={cn('mb-0.5 text-xs font-semibold', speakerColor?.text)}>
                    {speakerChar.name}
                  </div>
                )}

                {editingId === m.id ? (
                  <div className="min-w-[16rem] space-y-1.5">
                    <Textarea
                      className="min-h-24 text-sm"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                    />
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={cancelEdit}>
                        取消
                      </Button>
                      <Button size="sm" onClick={saveEdit}>
                        保存
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {m.content ? (
                      <MessageContent content={m.content} />
                    ) : isStreaming ? (
                      <span className="text-muted-foreground">…</span>
                    ) : null}
                    {isStreaming && <StreamingCursor />}
                  </>
                )}

                {canOperate && !streaming && editingId !== m.id && (
                  <div
                    className={cn(
                      'mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
                      isUser && !isGmCommand ? 'justify-end' : 'justify-start',
                    )}
                  >
                    {!isUser && isLastAi && (
                      <button
                        type="button"
                        title="重新生成"
                        onClick={() => regenerateMessage()}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <RefreshCw className="size-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="从此分支出新对话"
                      onClick={() => forkFromMessage(m.id)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <GitBranch className="size-3" />
                    </button>
                    <button
                      type="button"
                      title="编辑"
                      onClick={() => startEdit(m)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      onClick={() => deleteMessage(m.id)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 输入区 */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <Textarea
          className="max-h-32 min-h-10 flex-1 resize-none"
          placeholder={
            !activeConversation
              ? '先选择角色'
              : activeConversation.mode === 'group'
                ? '在群聊中发言… /GM 推动剧情 (Enter 发送, Shift+Enter 换行)'
                : activeCharacter
                  ? `和 ${activeCharacter.name} 说点什么… /GM 推动剧情 (Enter 发送, Shift+Enter 换行)`
                  : '输入你的话… /GM 推动剧情 (Enter 发送, Shift+Enter 换行)'
          }
          value={input}
          disabled={!activeConversation || streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <Button
          onClick={handleSend}
          disabled={!activeConversation || streaming || !input.trim()}
          className="h-10"
        >
          <Send className="h-4 w-4" />
          {streaming ? '生成中…' : '发送'}
        </Button>
      </div>

      {/* 切换到群聊: 选角色对话框 */}
      <Dialog
        open={groupPickerOpen}
        onClose={() => {
          setGroupPickerOpen(false)
          setGroupIds([])
        }}
        className="max-w-md"
      >
        <DialogHeader
          onClose={() => {
            setGroupPickerOpen(false)
            setGroupIds([])
          }}
        >
          <DialogTitle>切换到群聊剧场</DialogTitle>
          <DialogDescription>选择 2-10 个角色进入同一场景 (当前角色会自动保留)</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {characters.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              当前世界还没有角色
            </p>
          ) : (
            characters.map((c) => {
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
                      checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input',
                    )}
                  >
                    {checked && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="flex-1 truncate font-medium">{c.name}</span>
                  {c.personality && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {c.personality}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setGroupPickerOpen(false)
              setGroupIds([])
            }}
          >
            取消
          </Button>
          <Button size="sm" onClick={handleConfirmGroup} disabled={groupIds.length < 2}>
            确认切换 ({groupIds.length})
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 重命名对话弹窗 */}
      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} className="max-w-md">
        <DialogHeader onClose={() => setRenameOpen(false)}>
          <DialogTitle>重命名对话</DialogTitle>
          <DialogDescription>
            修改对话标题（留空则使用默认标题）。当前对话：
            {activeConversation?.mode === 'group'
              ? ' 群聊'
              : ` 与「${activeCharacter?.name ?? '未知'}」`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="输入新的对话标题"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && activeConversation && renameValue.trim()) {
                renameConversation(activeConversation.id, renameValue.trim())
                setRenameOpen(false)
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setRenameOpen(false)}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!renameValue.trim()}
            onClick={() => {
              if (activeConversation) {
                renameConversation(activeConversation.id, renameValue.trim())
                setRenameOpen(false)
              }
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除对话确认弹窗 */}
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} className="max-w-md">
        <DialogHeader onClose={() => setDeleteOpen(false)}>
          <DialogTitle>删除对话</DialogTitle>
          <DialogDescription>
            此操作不可撤销，将永久删除该对话及其所有消息记录。
            {activeConversation && activeConversation.mode === 'group' && ' 群聊成员关系也会一并清除。'}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="mb-1 font-medium text-destructive">确认删除以下对话？</div>
          <div className="text-muted-foreground">
            {activeConversation?.title
              ? activeConversation.title
              : activeConversation?.mode === 'group'
                ? '未命名群聊'
                : `与「${activeCharacter?.name ?? '未知角色'}」的对话`}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (activeConversation) {
                deleteConversation(activeConversation.id)
                setDeleteOpen(false)
              }
            }}
          >
            <Trash2 className="size-3.5" />
            确认删除
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
