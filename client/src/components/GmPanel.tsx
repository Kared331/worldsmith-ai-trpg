import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bot, Cog, Loader2, Pencil, Send } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Button } from './ui/Button'
import { Textarea } from './ui/Textarea'
import { toast } from './ui/Toast'
import { cn } from '../lib/utils'
import type { GmOutcome } from '@worldsmith/shared'

function OutcomeCard({ outcome }: { outcome: GmOutcome }) {
  const { chooseOutcome } = useAppStore()
  const [editing, setEditing] = useState(false)
  const [custom, setCustom] = useState('')

  const codeSummary =
    (outcome.codeResult as { summary?: string } | null)?.summary ??
    JSON.stringify(outcome.codeResult)

  return (
    <div className="mt-1 rounded-md border border-border bg-secondary/40 p-2 text-xs">
      <div className="flex items-center gap-1 font-medium text-primary">
        <AlertTriangle className="size-3" />
        系统判定 · {outcome.skillName}
      </div>
      <div className="mt-1 text-muted-foreground">
        <span className="text-foreground">代码引擎:</span> {codeSummary}
      </div>
      <div className="mt-0.5 text-muted-foreground">
        <span className="text-foreground">GM 叙事:</span>{' '}
        {outcome.gmNarrative.length > 60
          ? `${outcome.gmNarrative.slice(0, 60)}…`
          : outcome.gmNarrative}
      </div>
      <div className="mt-0.5 text-muted-foreground">
        当前选择:{' '}
        <span className="text-primary">
          {outcome.playerChoice === 'gm'
            ? 'GM 叙事'
            : outcome.playerChoice === 'code'
              ? '系统判定'
              : '自定义'}
        </span>
      </div>

      {editing ? (
        <div className="mt-1.5 space-y-1">
          <Textarea
            className="h-14 min-h-0 resize-none text-xs"
            placeholder="写下你想要的结局…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!custom.trim()}
              onClick={async () => {
                await chooseOutcome(outcome.id, 'custom', custom.trim())
                setEditing(false)
                setCustom('')
              }}
            >
              采用自定义
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setEditing(false)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex gap-1">
          <Button
            size="sm"
            variant="default"
            className={cn('h-6 px-2 text-xs', outcome.playerChoice !== 'gm' && 'opacity-50')}
            onClick={() => chooseOutcome(outcome.id, 'gm')}
          >
            <Bot className="size-3" /> GM 叙事
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={cn('h-6 px-2 text-xs', outcome.playerChoice !== 'code' && 'opacity-50')}
            onClick={() => chooseOutcome(outcome.id, 'code')}
          >
            <Cog className="size-3" /> 系统判定
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className={cn('h-6 px-2 text-xs', outcome.playerChoice !== 'custom' && 'opacity-50')}
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3" /> 自定义
          </Button>
        </div>
      )}
    </div>
  )
}

export function GmPanel() {
  const {
    gmMessages,
    gmStreaming,
    gmThinking,
    gmError,
    gmOutcomes,
    loadGmMessages,
    loadGmOutcomes,
    sendGmMessage,
  } = useAppStore()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadGmMessages()
    loadGmOutcomes()
  }, [loadGmMessages, loadGmOutcomes])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [gmMessages, gmStreaming])

  useEffect(() => {
    if (gmError) toast.error(gmError)
  }, [gmError])

  async function handleSend() {
    const content = input.trim()
    if (!content || gmStreaming) return
    setInput('')
    await sendGmMessage(content)
    loadGmOutcomes()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">GM Agent</span>
        <span className="ml-auto text-xs text-muted-foreground">
          元对话 · /gm 亦可唤起
        </span>
      </div>

      {/* GM 消息流 */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {gmMessages.length === 0 && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            与 Game Master 讨论世界规则、事件生成、任务设计。
            <br />
            主对话框输入 <code className="text-primary">/gm 你的问题</code>{' '}
            也可唤起。
          </p>
        )}
        {gmMessages.map((m) => {
          const isUser = m.role === 'user'
          const outcomes = gmOutcomes.filter((o) => o.gmMessageId === m.id)
          return (
            <div key={m.id} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[90%] whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-xs',
                  isUser
                    ? 'bg-primary/20 text-primary-foreground'
                    : 'border border-border bg-card text-card-foreground',
                )}
              >
                {m.content || (m.id === 'gm-streaming' ? '…' : '')}
                {m.id === 'gm-streaming' && (
                  <span className="ml-0.5 animate-pulse">▌</span>
                )}
                {!isUser && m.id !== 'gm-streaming' && outcomes.map((o) => (
                  <OutcomeCard key={o.id} outcome={o} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {gmStreaming && gmThinking && (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            GM 正在思考中，请稍候…
          </span>
        </div>
      )}

      {/* GM 输入区 */}
      <div className="flex items-end gap-2 border-t border-border p-2">
        <Textarea
          className="max-h-24 min-h-9 resize-none text-xs"
          placeholder="问 GM 任何关于世界的问题…"
          value={input}
          disabled={gmStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <Button size="icon" className="h-9 w-9 shrink-0" onClick={handleSend} disabled={gmStreaming || !input.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
