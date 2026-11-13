// ============================================================
// 角色头像色板 — 名字 hash → 稳定色
// 全局共享: ChatPanel / CharacterPanel / MapPanel 等保持一致
// ============================================================

export const AVATAR_COLORS = [
  { bg: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-500/50' },
  { bg: 'bg-rose-500', text: 'text-rose-400', border: 'border-rose-500/50' },
  { bg: 'bg-sky-500', text: 'text-sky-400', border: 'border-sky-500/50' },
  { bg: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/50' },
  { bg: 'bg-violet-500', text: 'text-violet-400', border: 'border-violet-500/50' },
  { bg: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-500/50' },
  { bg: 'bg-cyan-500', text: 'text-cyan-400', border: 'border-cyan-500/50' },
  { bg: 'bg-pink-500', text: 'text-pink-400', border: 'border-pink-500/50' },
]

export function colorForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// ============================================================
// 硬核 RPG 状态栏 — 数值解析 + 配色
// ============================================================

/** 已知 RPG 键名 → 配色配置 (HP 红 / MP 蓝 / 体力 绿 / 饱食橙 / 经验紫) */
export interface RpgStatConfig {
  /** 进度条填充色 (tailwind bg-class) */
  bar: string
  /** 图标默认色 */
  text: string
  /** 默认上限 (value 无 /max 时使用) */
  defaultMax: number
  /** 是否低值警告 (低于阈值变红) */
  lowWarn?: number
}

export const RPG_STAT_CONFIG: Record<string, RpgStatConfig> = {
  hp: { bar: 'bg-rose-500', text: 'text-rose-400', defaultMax: 100, lowWarn: 30 },
  mp: { bar: 'bg-sky-500', text: 'text-sky-400', defaultMax: 100, lowWarn: 20 },
  exp: { bar: 'bg-violet-500', text: 'text-violet-400', defaultMax: 100 },
  stamina: { bar: 'bg-emerald-500', text: 'text-emerald-400', defaultMax: 100, lowWarn: 20 },
  hunger: { bar: 'bg-orange-500', text: 'text-orange-400', defaultMax: 100, lowWarn: 30 },
  sp: { bar: 'bg-cyan-500', text: 'text-cyan-400', defaultMax: 100, lowWarn: 20 },
  sanity: { bar: 'bg-fuchsia-500', text: 'text-fuchsia-400', defaultMax: 100, lowWarn: 30 },
  lust: { bar: 'bg-pink-500', text: 'text-pink-400', defaultMax: 100 },
  arousal: { bar: 'bg-pink-500', text: 'text-pink-400', defaultMax: 100 },
  mood: { bar: 'bg-amber-500', text: 'text-amber-400', defaultMax: 100 },
}

export interface ParsedStatValue {
  current: number
  max: number
  percent: number
  isNumeric: boolean
}

/** 解析状态值: "85/100" | "85" | "85%" | 文本 → {current, max, percent} */
export function parseStatValue(value: string, key: string): ParsedStatValue {
  const cfg = RPG_STAT_CONFIG[key]
  const defaultMax = cfg?.defaultMax ?? 100

  // "85/100" 格式
  const slashMatch = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  if (slashMatch) {
    const current = parseFloat(slashMatch[1])
    const max = parseFloat(slashMatch[2])
    return { current, max, percent: max > 0 ? (current / max) * 100 : 0, isNumeric: true }
  }

  // "85%" 格式
  const pctMatch = value.match(/^(\d+(?:\.\d+)?)\s*%/)
  if (pctMatch) {
    const current = parseFloat(pctMatch[1])
    return { current, max: 100, percent: current, isNumeric: true }
  }

  // 纯数字 "85"
  const numMatch = value.match(/^(\d+(?:\.\d+)?)$/)
  if (numMatch) {
    const current = parseFloat(numMatch[1])
    const max = cfg?.defaultMax ?? Math.max(current, 100)
    return { current, max, percent: max > 0 ? (current / max) * 100 : 0, isNumeric: true }
  }

  return { current: 0, max: 0, percent: 0, isNumeric: false }
}

/** 根据百分比 + 配色判断是否低值警告 (HP < 30% 变红闪烁) */
export function isLowWarning(key: string, percent: number): boolean {
  const cfg = RPG_STAT_CONFIG[key]
  if (!cfg?.lowWarn) return false
  return percent < cfg.lowWarn
}
