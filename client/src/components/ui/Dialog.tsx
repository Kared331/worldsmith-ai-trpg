import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

// 极简 Dialog: 遮罩 + 居中 + Esc 关闭 + 点击遮罩关闭, 无 radix 依赖

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onClose, children, className }: DialogProps) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

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
