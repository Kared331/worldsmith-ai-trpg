import * as React from 'react'
import { cn } from '../../lib/utils'

// 极简 Tooltip: hover/focus 显示, 无依赖, CSS 定位
interface TooltipProps {
  content: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'bottom'
  className?: string
}

export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const [open, setOpen] = React.useState(false)
  const childProps = {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
  }
  return (
    <span className="relative inline-flex">
      {React.cloneElement(children, childProps)}
      {open && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-fade-in',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
