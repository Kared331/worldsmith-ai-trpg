import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Castle,
  Home,
  Map as MapIcon,
  MapPin,
  Mountain,
  Plus,
  Trash2,
  Trees,
  Waves,
  Hammer,
  ZoomIn,
  ZoomOut,
  LocateFixed,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { cn } from '../lib/utils'
import type { LocationType, WorldLocation } from '@worldsmith/shared'

// 地点类型 → 图标 + 颜色 (暗色地图风格)
const TYPE_CONFIG: Record<LocationType, { icon: LucideIcon; color: string; ring: string }> = {
  town: { icon: Home, color: '#d97706', ring: '#f59e0b' },
  forest: { icon: Trees, color: '#15803d', ring: '#22c55e' },
  mountain: { icon: Mountain, color: '#78716c', ring: '#a8a29e' },
  lake: { icon: Waves, color: '#0369a1', ring: '#0ea5e9' },
  dungeon: { icon: Castle, color: '#991b1b', ring: '#dc2626' },
  other: { icon: MapPin, color: '#6b7280', ring: '#9ca3af' },
}

// ============================================================
// MapPanel: 纯 SVG 自绘地图 (弃用 ReactFlow)
// 暗色背景 + 地形纹理 + 圆形地标 + 曲线道路
// ============================================================

export function MapPanel() {
  const {
    locations,
    connections,
    selectedLocation,
    directorMode,
    loadWorld,
    createLocation,
    updateLocation,
    deleteLocation,
    selectLocation,
    toggleDirectorMode,
  } = useAppStore()

  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', type: 'other' as LocationType })

  // 视口状态: pan + zoom
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  // 拖拽中节点的实时偏移 (用于视觉更新)
  const [dragOffset, setDragOffset] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 拖拽状态
  const dragRef = useRef<{
    mode: 'pan' | 'node' | null
    startX: number
    startY: number
    origPanX: number
    origPanY: number
    nodeId: string | null
    origNodeX: number
    origNodeY: number
  }>({
    mode: null, startX: 0, startY: 0,
    origPanX: 0, origPanY: 0, nodeId: null, origNodeX: 0, origNodeY: 0,
  })

  useEffect(() => {
    loadWorld()
  }, [loadWorld])

  // 挂载时清除残留的地点选中 (地图已弹窗化, 每次打开都是全新挂载)
  useEffect(() => {
    selectLocation(null)
  }, [selectLocation])

  // 计算节点屏幕位置 (数据库坐标 → 屏幕像素)
  const toScreen = useCallback((dbX: number, dbY: number) => {
    return {
      x: dbX * zoom + pan.x,
      y: dbY * zoom + pan.y,
    }
  }, [zoom, pan])

  // 计算屏幕位置 → 数据库坐标
  const toDb = useCallback((screenX: number, screenY: number) => {
    return {
      x: Math.round((screenX - pan.x) / zoom),
      y: Math.round((screenY - pan.y) / zoom),
    }
  }, [zoom, pan])

  // ---- 缩放 ----
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const delta = -e.deltaY * 0.001
    const newZoom = Math.max(0.3, Math.min(3, zoom * (1 + delta)))
    // 以鼠标位置为缩放中心
    const dbX = (mx - pan.x) / zoom
    const dbY = (my - pan.y) / zoom
    setPan({ x: mx - dbX * newZoom, y: my - dbY * newZoom })
    setZoom(newZoom)
  }, [zoom, pan])

  // ---- 拖拽: 背景平移 ----
  const handleMouseDownBg = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // 点击空白处取消地点选中
    selectLocation(null)
    dragRef.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
      nodeId: null,
      origNodeX: 0,
      origNodeY: 0,
    }
  }, [pan, selectLocation])

  // ---- 拖拽: 节点移动 ----
  const handleMouseDownNode = useCallback((e: React.MouseEvent, loc: WorldLocation) => {
    e.stopPropagation()
    if (e.button !== 0) return
    selectLocation(loc)
    if (!directorMode) return
    dragRef.current = {
      mode: 'node',
      startX: e.clientX,
      startY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
      nodeId: loc.id,
      origNodeX: loc.x,
      origNodeY: loc.y,
    }
  }, [pan, directorMode, selectLocation])

  // ---- 拖拽移动 ----
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current
    if (!d.mode) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'pan') {
      setPan({ x: d.origPanX + dx, y: d.origPanY + dy })
    } else if (d.mode === 'node' && d.nodeId) {
      // 更新视觉偏移 (屏幕像素), 松手时转换为数据库坐标写入
      setDragOffset({ id: d.nodeId, dx, dy })
    }
  }, [])

  // ---- 拖拽结束 ----
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current
    if (d.mode === 'node' && d.nodeId) {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        const newX = Math.round(d.origNodeX + dx / zoom)
        const newY = Math.round(d.origNodeY + dy / zoom)
        updateLocation(d.nodeId, { x: newX, y: newY })
      }
    }
    dragRef.current.mode = null
    setDragOffset(null)
  }, [zoom, updateLocation])

  // ---- 居中视图 ----
  const fitView = useCallback(() => {
    if (locations.length === 0) {
      setPan({ x: 0, y: 0 })
      setZoom(1)
      return
    }
    const xs = locations.map((l) => l.x)
    const ys = locations.map((l) => l.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const padding = 60
    const w = maxX - minX + padding * 2
    const h = maxY - minY + padding * 2
    const z = Math.min(rect.width / w, rect.height / h, 1.5)
    setZoom(z)
    setPan({
      x: -minX * z + (rect.width - (maxX - minX) * z) / 2,
      y: -minY * z + (rect.height - (maxY - minY) * z) / 2,
    })
  }, [locations])

  // 首次加载或地点数变化时自动居中
  useEffect(() => {
    if (locations.length > 0 && pan.x === 0 && pan.y === 0 && zoom === 1) {
      fitView()
    }
  }, [locations, fitView, pan, zoom])

  // ---- 创建地点 ----
  async function handleCreate() {
    if (!form.name.trim()) return
    // 新节点放在当前视口中心对应的数据库坐标
    const rect = containerRef.current?.getBoundingClientRect()
    const centerDb = rect ? toDb(rect.width / 2, rect.height / 2) : { x: 200, y: 150 }
    await createLocation({
      name: form.name.trim(),
      description: form.description.trim(),
      type: form.type,
      x: centerDb.x,
      y: centerDb.y,
    })
    setForm({ name: '', description: '', type: 'other' })
    setCreating(false)
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-[#0d0e10] select-none"
      onWheel={handleWheel}
      onMouseDown={handleMouseDownBg}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: dragRef.current.mode === 'pan' ? 'grabbing' : 'grab' }}
    >
      {/* SVG 层: 背景 + 道路连线 */}
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: 'none' }}
      >
        <defs>
          {/* 暗色网格纹理 */}
          <pattern id="map-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1a1b1e" strokeWidth="0.5" />
          </pattern>
          {/* 地形渐变 */}
          <radialGradient id="map-vignette" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="#141518" stopOpacity="0" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.5" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#map-grid)" />
        <rect width="100%" height="100%" fill="url(#map-vignette)" />

        {/* 道路连线 (曲线, 无箭头) */}
        {connections.map((c) => {
          const from = locations.find((l) => l.id === c.fromId)
          const to = locations.find((l) => l.id === c.toId)
          if (!from || !to) return null
          // 计算拖拽中的偏移
          const fromDrag = dragOffset?.id === from.id ? dragOffset : null
          const toDrag = dragOffset?.id === to.id ? dragOffset : null
          const fromPos = toScreen(from.x, from.y)
          const toPos = toScreen(to.x, to.y)
          if (fromDrag) { fromPos.x += fromDrag.dx; fromPos.y += fromDrag.dy }
          if (toDrag) { toPos.x += toDrag.dx; toPos.y += toDrag.dy }
          // 二次贝塞尔曲线 (微弯)
          const midX = (fromPos.x + toPos.x) / 2
          const midY = (fromPos.y + toPos.y) / 2
          const dx = toPos.x - fromPos.x
          const dy = toPos.y - fromPos.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const curve = Math.min(dist * 0.15, 30)
          const perpX = -dy / (dist || 1) * curve
          const perpY = dx / (dist || 1) * curve
          const path = `M ${fromPos.x} ${fromPos.y} Q ${midX + perpX} ${midY + perpY} ${toPos.x} ${toPos.y}`
          return (
            <path
              key={c.id}
              d={path}
              fill="none"
              stroke="#3a3b3f"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={0.7}
            />
          )
        })}
      </svg>

      {/* HTML 节点层: 圆形地标 */}
      {locations.map((loc) => {
        const basePos = toScreen(loc.x, loc.y)
        // 拖拽中: 加上屏幕偏移
        const isDragging = dragOffset?.id === loc.id
        const screenX = basePos.x + (isDragging ? dragOffset!.dx : 0)
        const screenY = basePos.y + (isDragging ? dragOffset!.dy : 0)
        const cfg = TYPE_CONFIG[loc.type]
        const Icon = cfg.icon
        const isSelected = selectedLocation?.id === loc.id
        return (
          <div
            key={loc.id}
            className={cn(
              'absolute flex flex-col items-center gap-0.5',
              directorMode && 'cursor-move',
              !directorMode && 'cursor-pointer',
            )}
            style={{
              left: screenX,
              top: screenY,
              transform: 'translate(-50%, -50%)',
              zIndex: isSelected ? 20 : 10,
            }}
            onMouseDown={(e) => handleMouseDownNode(e, loc)}
          >
            {/* 地标圆点 */}
            <div
              className={cn(
                'flex items-center justify-center rounded-full border-2 transition-all',
                isSelected ? 'scale-110' : 'hover:scale-105',
              )}
              style={{
                width: 28 * Math.min(zoom, 1.5),
                height: 28 * Math.min(zoom, 1.5),
                backgroundColor: cfg.color + 'cc',
                borderColor: isSelected ? cfg.ring : cfg.color + '80',
                boxShadow: isSelected ? `0 0 12px ${cfg.ring}80` : 'none',
              }}
            >
              <Icon
                style={{
                  width: 14 * Math.min(zoom, 1.5),
                  height: 14 * Math.min(zoom, 1.5),
                }}
                className="text-white"
              />
            </div>
            {/* 名称标签 */}
            <span
              className="rounded bg-black/60 px-1.5 py-0.5 text-xs text-white/90 backdrop-blur-sm"
              style={{ fontSize: Math.max(10, 12 * Math.min(zoom, 1.3)) }}
            >
              {loc.name}
            </span>
          </div>
        )
      })}

      {/* 顶部工具栏 */}
      <div className="absolute left-2 top-2 z-30 flex items-center gap-1.5">
        <Button
          size="sm"
          variant={directorMode ? 'default' : 'outline'}
          className="h-7 text-xs"
          onClick={toggleDirectorMode}
        >
          <Hammer className="size-3" /> 导演模式
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3" /> 添加地点
        </Button>
      </div>

      {/* 右上角: 缩放控制 */}
      <div className="absolute right-2 top-2 z-30 flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0"
          onClick={() => setZoom((z) => Math.max(0.3, z * 0.8))}
          aria-label="缩小"
        >
          <ZoomOut className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0"
          onClick={() => setZoom((z) => Math.min(3, z * 1.25))}
          aria-label="放大"
        >
          <ZoomIn className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0"
          onClick={fitView}
          aria-label="居中"
        >
          <LocateFixed className="size-3" />
        </Button>
      </div>

      {/* 创建地点浮层 (右下角卡片; 地图已弹窗化, 用地图内浮层替代嵌套 Dialog, 避免 Esc 冲突) */}
      {creating && (
        <div className="absolute bottom-3 right-3 z-30 w-72 rounded-lg border border-border bg-popover p-3 shadow-lg animate-slide-up">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">添加地点</span>
            <button
              onClick={() => setCreating(false)}
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">地点名称</label>
              <Input
                autoFocus
                placeholder="地点名称 *"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && form.name.trim()) handleCreate()
                }}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">地点类型</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as LocationType })}
              >
                <option value="town">城镇</option>
                <option value="forest">森林</option>
                <option value="mountain">山脉</option>
                <option value="lake">湖泊</option>
                <option value="dungeon">地牢</option>
                <option value="other">其他</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">地点简介</label>
              <Textarea
                placeholder="地点的背景、特色、氛围等描述（可选）"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!form.name.trim()}>
              创建
            </Button>
          </div>
        </div>
      )}

      {/* 地点详情浮层 (左下角卡片) */}
      {selectedLocation && (
        <div className="absolute bottom-3 left-3 z-30 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg animate-slide-up">
          <div className="mb-1.5 flex items-center gap-1.5">
            {(() => {
              const Icon = TYPE_CONFIG[selectedLocation.type].icon
              return <Icon className="size-4 text-primary" />
            })()}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{selectedLocation.name}</span>
            <button
              onClick={() => selectLocation(null)}
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="关闭详情"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="space-y-2">
            {selectedLocation.description && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {selectedLocation.description}
              </p>
            )}
            {selectedLocation.tags && selectedLocation.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedLocation.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              坐标 ({selectedLocation.x}, {selectedLocation.y})
              {directorMode && ' · 可拖拽移动'}
            </div>
          </div>
          {directorMode && (
            <Button
              variant="destructive"
              size="sm"
              className="mt-2 w-full"
              onClick={() => deleteLocation(selectedLocation.id)}
            >
              <Trash2 className="size-3.5" /> 删除地点
            </Button>
          )}
        </div>
      )}

      {/* 空状态提示 */}
      {locations.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            <MapIcon className="h-6 w-6 opacity-50" />
            <span>世界还是空的 — 点击"添加地点"创建第一个节点</span>
          </div>
        </div>
      )}
    </div>
  )
}
