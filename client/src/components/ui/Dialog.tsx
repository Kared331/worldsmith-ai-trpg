import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

// 极简 Dialog: 遮罩 + 居中 + Esc 关闭 + 点击遮罩关闭, 无 radix 依赖

// ============================================================
// 打开中的 Dialog 栈
// 嵌套弹窗 (如"状态栏管理" + "状态项编辑") 若各自在 document 上监听 keydown,
// 按一次 Esc 会同时关闭全部; body.overflow 也会被内层重置而破坏外层的滚动锁。
// 因此: 只有栈顶响应 Esc, 只有栈空时才恢复滚动。
// ============================================================
const openStack: symbol[] = []
/** 第一个弹窗打开前的 body.overflow 原值 (栈空时恢复) */
let savedOverflow: string | null = null

/** 每个 Dialog 实例一个稳定 id */
function useDialogId(): symbol {
  const ref = React.useRef<symbol | null>(null)
  if (ref.current === null) ref.current = Symbol('dialog')
  return ref.current
}

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onClose, children, className }: DialogProps) {
  const dialogId = useDialogId()
  React.useEffect(() => {
    if (!open) return
    if (openStack.length === 0) savedOverflow = document.body.style.overflow
    openStack.push(dialogId)
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      // 只有最上层弹窗响应 Esc, 避免一次按键关闭多层
      if (e.key === 'Escape' && openStack[openStack.length - 1] === dialogId) onClose()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      const idx = openStack.lastIndexOf(dialogId)
      if (idx !== -1) openStack.splice(idx, 1)
      document.removeEventListener('keydown', onKey)
      // 只有最后一个弹窗关闭时才恢复滚动 (恢复的是最初的原值, 不是内层捕获的 'hidden')
      if (openStack.length === 0) {
        document.body.style.overflow = savedOverflow ?? ''
        savedOverflow = null
      }
    }
  }, [open, onClose, dialogId])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'relative z-10 w-full max-w-lg rounded-lg border border-border bg-popover p-6 shadow-lg animate-slide-up',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function DialogHeader({ children, onClose, className }: { children: React.ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div className={cn('mb-4 flex items-center justify-between', className)}>
      <div>{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="关闭"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

export function DialogTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)}>
      {children}
    </h2>
  )
}

export function DialogDescription({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('mt-1.5 text-sm text-muted-foreground', className)}>{children}</p>
  )
}

export function DialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mt-6 flex justify-end gap-2', className)}>{children}</div>
  )
}
