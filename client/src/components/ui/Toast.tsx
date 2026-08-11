import * as React from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '../../lib/utils'

// 极简 Toast: 全局 store + 右上角堆叠 + 自动消失, 无 radix 依赖

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  type: ToastType
  message: string
}

interface ToastStore {
  toasts: ToastItem[]
  add: (type: ToastType, message: string) => void
  remove: (id: string) => void
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (type, message) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 4000)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (msg: string) => useToastStore.getState().add('success', msg),
  error: (msg: string) => useToastStore.getState().add('error', msg),
  info: (msg: string) => useToastStore.getState().add('info', msg),
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const STYLES = {
  success: 'text-emerald-500',
  error: 'text-destructive',
  info: 'text-primary',
}

export function Toaster() {
  const { toasts, remove } = useToastStore()
  if (toasts.length === 0) return null
  return createPortal(
    <div className="fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border border-border bg-popover p-3 shadow-lg animate-slide-up',
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', STYLES[t.type])} />
            <p className="flex-1 text-sm text-foreground">{t.message}</p>
            <button
              onClick={() => remove(t.id)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="关闭"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
