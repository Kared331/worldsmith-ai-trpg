import { useEffect } from 'react'
import { Library, UserPlus, FileDown } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { toast } from './ui/Toast'

// ============================================================
// CharacterLibraryDialog: 角色库面板
// worldId 为 null 的角色 = 跨世界共享的角色库
// 功能: 列表 + 导入到当前世界 (复制副本) + 导出为 PNG 角色卡
// 注: detach 操作放在角色栏的右键菜单, 不在此面板
// ============================================================

interface Props {
  open: boolean
  onClose: () => void
}

export function CharacterLibraryDialog({ open, onClose }: Props) {
  const libraryCharacters = useAppStore((s) => s.libraryCharacters)
  const loadLibraryCharacters = useAppStore((s) => s.loadLibraryCharacters)
  const importCharacterToWorld = useAppStore((s) => s.importCharacterToWorld)
  const activeWorld = useAppStore((s) => s.activeWorld)

  // 打开时加载角色库
  useEffect(() => {
    if (open) loadLibraryCharacters()
  }, [open, loadLibraryCharacters])

  const handleImport = async (id: string) => {
    await importCharacterToWorld(id)
  }

  const handleExportPng = (characterId: string, name: string) => {
    // 角色卡导出走 /api/cards/export/:id, 直接触发下载
    const url = `/api/cards/export/${characterId}`
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    toast.success(`已导出「${name}」角色卡`)
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle>角色库</DialogTitle>
        <DialogDescription>
          角色库中的角色不属于任何世界，可导入到任意世界 (导入会复制副本，原角色保留在库中)。
        </DialogDescription>
      </DialogHeader>

      {/* 角色列表 */}
      <div className="max-h-[55vh] space-y-2 overflow-y-auto">
        {libraryCharacters.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Library className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">角色库为空</p>
            <p className="text-xs text-muted-foreground">
              删除世界时勾选「保留角色」或在角色栏将角色移入角色库，即可在此查看。
            </p>
          </div>
        ) : (
          libraryCharacters.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-accent/40"
            >
              {/* 头像 */}
              {c.avatar ? (
                <img
                  src={c.avatar}
                  alt={c.name}
                  className="size-10 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-sm font-medium text-muted-foreground">
                  {c.name.slice(0, 1)}
                </div>
              )}

              {/* 信息 */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.name}</div>
                {c.personality && (
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {c.personality}
                  </p>
                )}
                {c.background && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {c.background}
                  </p>
                )}
              </div>

              {/* 操作 */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => handleExportPng(c.id, c.name)}
                  aria-label="导出角色卡"
                  title="导出为 PNG 角色卡"
                >
                  <FileDown className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleImport(c.id)}
                  disabled={!activeWorld}
                  title={!activeWorld ? '请先选择一个世界' : '导入副本到当前世界'}
                >
                  <UserPlus className="size-3.5" />
                  导入
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
