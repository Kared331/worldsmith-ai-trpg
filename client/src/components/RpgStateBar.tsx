// ============================================================
// 硬核 RPG 状态栏组件
// 数值型状态 → 进度条 (HP/MP/饱食度/体力 等)
// 低值警告 → 红色高亮闪烁
// 文本型状态 → 图标 + 文本展示
// ============================================================

import {
  Heart, Droplet, Zap, Utensils, Brain, Flame, Activity,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../lib/utils'
import {
  RPG_STAT_CONFIG, parseStatValue, isLowWarning,
} from '../lib/character-color'

// RPG 键名 → 图标映射 (覆盖硬核 RPG 常用状态)
const RPG_KEY_ICONS: Record<string, LucideIcon> = {
  hp: Heart,
  mp: Droplet,
  stamina: Zap,
  hunger: Utensils,
  sp: Zap,
  sanity: Brain,
  lust: Flame,
  arousal: Flame,
  exp: Activity,
  mood: Activity,
}

// 状态栏最小契约 (PlayerState / CharacterState 都满足)
interface StatLike {
  key: string
  label: string
  value: string
  icon: string
}

interface Props {
  state: StatLike
  /** 是否紧凑模式 (列表展示用小尺寸) */
  compact?: boolean
}

export function RpgStateBar({ state, compact = false }: Props) {
  const cfg = RPG_STAT_CONFIG[state.key]
  const parsed = parseStatValue(state.value, state.key)

  // 非数值型 / 无 RPG 配色 → 退化为图标 + 文本
  if (!parsed.isNumeric || !cfg) {
    const IconComp = RPG_KEY_ICONS[state.key] ?? Activity
    return (
      <div className={cn(
        'inline-flex items-center gap-1.5 rounded bg-secondary/50 px-2 py-1 text-xs',
        compact && 'px-1.5 py-0.5',
      )}>
        <IconComp className="h-3 w-3 shrink-0 text-primary" />
        <span className="font-medium text-muted-foreground">{state.label}:</span>
        <span className="truncate text-foreground">{state.value || '（空）'}</span>
      </div>
    )
  }

  // 数值型 → 进度条
  const IconComp = RPG_KEY_ICONS[state.key] ?? Activity
  const lowWarn = isLowWarning(state.key, parsed.percent)
  const barColor = lowWarn ? 'bg-rose-500' : cfg.bar

  return (
    <div className={cn('space-y-0.5', compact && 'space-y-0')}>
      <div className="flex items-center justify-between gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
          <IconComp className={cn('h-3 w-3', lowWarn ? 'text-rose-400 animate-pulse' : cfg.text)} />
          {state.label}
        </span>
        <span className={cn(
          'font-mono tabular-nums',
          lowWarn ? 'text-rose-400 font-semibold' : 'text-foreground',
        )}>
          {Math.round(parsed.current)}<span className="text-muted-foreground">/{Math.round(parsed.max)}</span>
        </span>
      </div>
      <div className={cn(
        'overflow-hidden rounded-full bg-secondary',
        compact ? 'h-1' : 'h-1.5',
      )}>
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            barColor,
            lowWarn && 'animate-pulse',
          )}
          style={{ width: `${Math.max(0, Math.min(100, parsed.percent))}%` }}
        />
      </div>
    </div>
  )
}

// ============================================================
// RPG 状态预设 — 一键添加标准硬核 RPG 状态集
// ============================================================

export interface RpgPreset {
  key: string
  label: string
  value: string
  icon: string
}

export const RPG_PRESETS: Array<{ name: string; states: RpgPreset[] }> = [
  {
    name: '生存基础',
    states: [
      { key: 'hp', label: '生命', value: '100/100', icon: 'Heart' },
      { key: 'mp', label: '法力', value: '50/50', icon: 'Activity' },
      { key: 'stamina', label: '体力', value: '100/100', icon: 'Zap' },
      { key: 'hunger', label: '饱食度', value: '80/100', icon: 'Clock' },
    ],
  },
  {
    name: '精神状态',
    states: [
      { key: 'sanity', label: '理智', value: '100/100', icon: 'Brain' },
      { key: 'mood', label: '心情', value: '平静', icon: 'Activity' },
      { key: 'lust', label: '情欲', value: '0/100', icon: 'Activity' },
      { key: 'arousal', label: '兴奋', value: '0/100', icon: 'Activity' },
    ],
  },
  {
    name: '冒险属性',
    states: [
      { key: 'exp', label: '经验', value: '0/100', icon: 'Star' },
      { key: 'gold', label: '金币', value: '0', icon: 'Coins' },
      { key: 'level', label: '等级', value: '1', icon: 'Star' },
    ],
  },
  {
    name: '战斗属性',
    states: [
      { key: 'atk', label: '攻击', value: '10', icon: 'Swords' },
      { key: 'def', label: '防御', value: '5', icon: 'Shield' },
      { key: 'spd', label: '速度', value: '15', icon: 'Zap' },
      { key: 'crit', label: '暴击率', value: '5%', icon: 'Swords' },
      { key: 'hit', label: '命中率', value: '95%', icon: 'Swords' },
    ],
  },
  {
    name: '社交关系',
    states: [
      { key: 'affection', label: '好感度', value: '0/100', icon: 'Heart' },
      { key: 'trust', label: '信任', value: '0/100', icon: 'Heart' },
      { key: 'fear', label: '恐惧', value: '0/100', icon: 'Brain' },
      { key: 'loyalty', label: '忠诚', value: '50/100', icon: 'Heart' },
    ],
  },
  {
    name: '负面状态',
    states: [
      { key: 'poison', label: '中毒', value: '0', icon: 'Activity' },
      { key: 'burn', label: '燃烧', value: '0', icon: 'Flame' },
      { key: 'freeze', label: '冰冻', value: '0', icon: 'Droplet' },
      { key: 'stun', label: '眩晕', value: '0', icon: 'Brain' },
      { key: 'bleed', label: '流血', value: '0', icon: 'Heart' },
    ],
  },
  {
    name: '环境状态',
    states: [
      { key: 'time', label: '时间', value: '清晨', icon: 'Clock' },
      { key: 'weather', label: '天气', value: '晴', icon: 'Cloud' },
      { key: 'season', label: '季节', value: '春', icon: 'Leaf' },
      { key: 'atmosphere', label: '氛围', value: '平静', icon: 'Wind' },
    ],
  },
  {
    name: '成人向状态',
    states: [
      { key: 'lust', label: '情欲', value: '0/100', icon: 'Flame' },
      { key: 'arousal', label: '兴奋', value: '0/100', icon: 'Flame' },
      { key: 'sensitivity', label: '敏感度', value: '0/100', icon: 'Flame' },
      { key: 'corruption', label: '堕落', value: '0/100', icon: 'Brain' },
      { key: 'submission', label: '顺从', value: '0/100', icon: 'Brain' },
    ],
  },
]
