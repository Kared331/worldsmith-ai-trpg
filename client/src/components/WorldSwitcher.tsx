import { useEffect, useRef, useState } from 'react'
import { Globe, ChevronDown, Check, Plus, Settings2, Library } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { cn } from '../lib/utils'
import { WorldManagerDialog } from './WorldManagerDialog'
import { CharacterLibraryDialog } from './CharacterLibraryDialog'

// ============================================================
// WorldSwitcher: 顶部世界切换器
// 触发按钮 + 下拉菜单 (世界列表 / 新建 / 管理 / 角色库)
// 挂载 WorldManagerDialog + CharacterLibraryDialog (本组件控制开关)
// ============================================================

export function WorldSwitcher() {
  const worlds = useAppStore((s) => s.worlds)
  const activeWorld = useAppStore((s) => s.activeWorld)
  const switchWorld = useAppStore((s) => s.switchWorld)

  const [open, setOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handleSelect = async (id: string) => {
    setOpen(false)
    if (id !== activeWorld?.id) await switchWorld(id)
  }

  return (
    <div ref={containerRef} className="relative z-30">
      {/* 触发按钮 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-border/60 bg-popover/80 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-popover"
        aria-label="切换世界"
        title={activeWorld ? `${activeWorld.name} — 点击切换` : '点击选择世界'}
      >
        <Globe className="size-3.5 text-primary" />
        <span className="max-w-[140px] truncate">
          {activeWorld?.name ?? '未选择世界'}
        </span>
        <ChevronDown
          className={cn(
            'size-3 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg animate-slide-up">
          {/* 世界列表 */}
          <div className="max-h-60 overflow-y-auto">
            {worlds.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                暂无世界
              </div>
            )}
            {worlds.map((w) => {
              const isActive = w.id === activeWorld?.id
              return (
                <button
                  key={w.id}
                  onClick={() => handleSelect(w.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  <Globe className="size-3.5 shrink-0 opacity-70" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{w.name}</div>
                    {w.description && (
                      <div className="truncate text-xs text-muted-foreground">
                        {w.description}
                      </div>
                    )}
                  </div>
                  {isActive && <Check className="size-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>

          {/* 分隔线 */}
          <div className="my-1 border-t border-border" />

          {/* 操作入口 */}
          <button
            onClick={() => {
              setOpen(false)
              setCreateOpen(true)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Plus className="size-3.5 opacity-70" />
            <span>新建世界</span>
          </button>
          <button
            onClick={() => {
              setOpen(false)
              setManagerOpen(true)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Settings2 className="size-3.5 opacity-70" />
            <span>管理世界</span>
          </button>
          <button
            onClick={() => {
              setOpen(false)
              setLibraryOpen(true)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Library className="size-3.5 opacity-70" />
            <span>角色库</span>
          </button>
        </div>
      )}

      {/* 世界管理面板 (含新建/改名/删除) */}
      <WorldManagerDialog
        open={managerOpen || createOpen}
        onClose={() => {
          setManagerOpen(false)
          setCreateOpen(false)
        }}
        initialMode={createOpen ? 'create' : 'list'}
      />

      {/* 角色库面板 */}
      <CharacterLibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </div>
  )
}
