import { useEffect, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings, User, ScrollText, Map as MapIcon, X } from 'lucide-react'
import { useAppStore } from './store/appStore'
import { MapPanel } from './components/MapPanel'
import { CharacterPanel } from './components/CharacterPanel'
import { ChatPanel } from './components/ChatPanel'
import { GmPanel } from './components/GmPanel'
import { LlmConfigPanel } from './components/LlmConfigPanel'
import { WorldSwitcher } from './components/WorldSwitcher'
import { PersonaDialog } from './components/PersonaDialog'
import { WorldRulesDialog } from './components/WorldRulesDialog'
import { Dialog } from './components/ui/Dialog'
import { Toaster } from './components/ui/Toast'
import { Button } from './components/ui/Button'
import { cn } from './lib/utils'

export default function App() {
  const loadWorlds = useAppStore((s) => s.loadWorlds)
  const loadCharacters = useAppStore((s) => s.loadCharacters)
  const loadWorld = useAppStore((s) => s.loadWorld)
  const loadGmMessages = useAppStore((s) => s.loadGmMessages)
  const loadGmOutcomes = useAppStore((s) => s.loadGmOutcomes)
  const loadPlayerStates = useAppStore((s) => s.loadPlayerStates)
  const loadCharacterStates = useAppStore((s) => s.loadCharacterStates)
  const loadActivePersona = useAppStore((s) => s.loadActivePersona)
  const loadWorldRules = useAppStore((s) => s.loadWorldRules)
  const activeWorld = useAppStore((s) => s.activeWorld)
  const activePersona = useAppStore((s) => s.activePersona)
  const worldRules = useAppStore((s) => s.worldRules)
  const setLlmConfigOpen = useAppStore((s) => s.setLlmConfigOpen)
  const setPersonaDialogOpen = useAppStore((s) => s.setPersonaDialogOpen)
  const setRulesDialogOpen = useAppStore((s) => s.setRulesDialogOpen)
  const [showLeft, setShowLeft] = useState(true)
  const [showRight, setShowRight] = useState(true)
  const [mapOpen, setMapOpen] = useState(false)

  // 首次加载世界列表 (loadWorlds 内部会选定默认世界并同步 header)
  useEffect(() => {
    loadWorlds()
    loadActivePersona()
  }, [loadWorlds, loadActivePersona])

  // 世界就绪后加载业务数据 (依赖 activeWorld, 切换世界时由 switchWorld 负责重载)
  // 并行加载: 总延迟 = max(各请求) 而非 sum
  useEffect(() => {
    if (!activeWorld) return
    Promise.all([
      loadCharacters(),
      loadWorld(),
      loadGmMessages(),
      loadGmOutcomes(),
      loadPlayerStates(),
      loadCharacterStates(),
      loadWorldRules(),
    ])
  }, [activeWorld, loadCharacters, loadWorld, loadGmMessages, loadGmOutcomes, loadPlayerStates, loadCharacterStates, loadWorldRules])

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* 顶部工具栏: 世界切换 + 地图入口 + 人设/规则/LLM 配置 */}
      <header className="relative z-40 flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        {/* 左侧: 世界切换器 + 地图入口 */}
        <div className="flex items-center gap-2">
          <WorldSwitcher />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => setMapOpen(true)}
            aria-label="打开世界地图"
            title="打开世界地图"
          >
            <MapIcon className="size-3.5" />
            地图
          </Button>
        </div>
        {/* 右侧: 玩家人设 + 世界规则 + LLM 配置 */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 gap-1.5 px-2 text-xs',
              activePersona ? 'text-primary' : 'text-muted-foreground',
            )}
            onClick={() => setPersonaDialogOpen(true)}
            aria-label="玩家人设"
            title="玩家人设"
          >
            <User className="size-3.5" />
            {activePersona ? activePersona.name : '人设'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 gap-1.5 px-2 text-xs',
              worldRules.length > 0 ? 'text-primary' : 'text-muted-foreground',
            )}
            onClick={() => setRulesDialogOpen(true)}
            aria-label="世界规则"
            title="世界规则"
          >
            <ScrollText className="size-3.5" />
            {worldRules.length > 0 ? `${worldRules.length}` : '规则'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => setLlmConfigOpen(true)}
            aria-label="LLM 配置"
            title="LLM 配置"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      {/* 三栏: 左角色 / 中对话 / 右 GM */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧: 角色栏 (可折叠) */}
        <aside
          className={cn(
            'shrink-0 overflow-hidden border-r border-border transition-[width] duration-200',
            showLeft ? 'w-64' : 'w-0',
          )}
        >
          <div className="h-full w-64">
            <CharacterPanel />
          </div>
        </aside>

        {/* 中间: 主对话框 */}
        <main className="relative min-w-0 flex-1">
          {/* 折叠开关 */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-2 z-10 h-7 w-7 text-muted-foreground"
            onClick={() => setShowLeft((v) => !v)}
            aria-label={showLeft ? '收起角色栏' : '展开角色栏'}
          >
            {showLeft ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-10 h-7 w-7 text-muted-foreground"
            onClick={() => setShowRight((v) => !v)}
            aria-label={showRight ? '收起 GM 栏' : '展开 GM 栏'}
          >
            {showRight ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </Button>
          <ChatPanel />
        </main>

        {/* 右侧: GM 面板 (可折叠) */}
        <aside
          className={cn(
            'shrink-0 overflow-hidden border-l border-border transition-[width] duration-200',
            showRight ? 'w-72' : 'w-0',
          )}
        >
          <div className="h-full w-72">
            <GmPanel />
          </div>
        </aside>
      </div>

      {/* 全局 Toast */}
      <Toaster />

      {/* LLM 配置面板 */}
      <LlmConfigPanel />

      {/* 世界地图弹窗: 点击工具栏「地图」按钮打开 */}
      <Dialog open={mapOpen} onClose={() => setMapOpen(false)} className="max-w-6xl p-0">
        <div className="flex h-[80vh] flex-col overflow-hidden rounded-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <MapIcon className="size-4 text-primary" />
              世界地图
            </span>
            <button
              onClick={() => setMapOpen(false)}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="关闭地图"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <MapPanel />
          </div>
        </div>
      </Dialog>

      {/* 玩家人设编辑器 */}
      <PersonaDialog />

      {/* 世界规则编辑器 */}
      <WorldRulesDialog />
    </div>
  )
}
