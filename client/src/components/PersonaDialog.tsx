import { useEffect, useState } from 'react'
import { User } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'

// ============================================================
// PersonaDialog: 玩家人设编辑器
// 让 AI 知道"玩家是谁", 注入到所有对话的 system prompt
// ============================================================

export function PersonaDialog() {
  const open = useAppStore((s) => s.personaDialogOpen)
  const setOpen = useAppStore((s) => s.setPersonaDialogOpen)
  const activePersona = useAppStore((s) => s.activePersona)
  const saveActivePersona = useAppStore((s) => s.saveActivePersona)
  const clearActivePersona = useAppStore((s) => s.clearActivePersona)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // 打开时同步当前人设
  useEffect(() => {
    if (open) {
      setName(activePersona?.name ?? '')
      setDescription(activePersona?.description ?? '')
    }
  }, [open, activePersona])

  async function handleSave() {
    if (!name.trim()) return
    await saveActivePersona({ name: name.trim(), description: description.trim() })
    setOpen(false)
  }

  async function handleClear() {
    await clearActivePersona()
    setOpen(false)
  }

  return (
    <Dialog open={open} onClose={() => setOpen(false)}>
      <DialogHeader onClose={() => setOpen(false)}>
        <div className="flex items-center gap-2">
          <User className="size-5 text-primary" />
          <div>
            <DialogTitle>玩家人设</DialogTitle>
            <DialogDescription>设定你自己的身份，让 AI 更了解你</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">你的名字</label>
          <Input
            placeholder="你想被怎么称呼？"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">
            关于你自己（性格 / 背景 / 说话风格 / 偏好）
          </label>
          <Textarea
            placeholder="例如：我喜欢幽默的对话，偏爱理性决策，说话简洁直接。正在寻找一场史诗般的冒险。"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={5000}
          />
          <p className="text-right text-xs text-muted-foreground/60">
            {description.length}/5000
          </p>
        </div>
        <p className="rounded-md bg-secondary/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
          人设会注入到所有对话（角色扮演 / 文字冒险 / 群聊）的开头，跨世界生效。
          留空名字则不启用人设。
        </p>
      </div>

      <DialogFooter>
        {activePersona && (
          <Button variant="ghost" onClick={handleClear} className="mr-auto">
            清除人设
          </Button>
        )}
        <Button variant="outline" onClick={() => setOpen(false)}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={!name.trim()}>
          保存
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
