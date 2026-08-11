import { Fragment, type ReactNode } from 'react'

// ============================================================
// MessageContent: 对话文本高亮标记渲染 (SillyTavern 风格)
// - *动作* / （动作）  → 斜体灰色 (动作/心理描写)
// - **强调**           → 加粗 (重点强调)
// - "对话" / "对话"    → 主色高亮 (角色台词, 保留原始引号)
// - ((OOC))            → 灰色小字 (出戏/元信息)
// 换行通过 whitespace-pre-wrap 保留, 此组件只做行内标记
// ============================================================

type SegmentType = 'normal' | 'action' | 'bold' | 'dialogue' | 'ooc'

interface Segment {
  type: SegmentType
  text: string
  /** dialogue 专用: 还原原始引号 (中文/英文) */
  quote?: '"' | '"' | '"'
}

/**
 * 统一正则: 依次匹配
 * 1. **加粗**
 * 2. *动作斜体*
 * 3. （中文圆括号动作）— 中文 RP 惯用写法
 * 4. "中文引号台词"
 * 5. "英文引号台词"
 * 6. ((OOC))
 */
const TOKEN_RE =
  /\*\*([^*]+)\*\*|\*([^*]+)\*|（([^（）]+)）|"([^"]+)"|"([^"]+)"|\(\(([^)]+)\)\)/g

function tokenize(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'normal', text: text.slice(last, match.index) })
    }
    if (match[1] !== undefined) {
      segments.push({ type: 'bold', text: match[1] })
    } else if (match[2] !== undefined) {
      segments.push({ type: 'action', text: match[2] })
    } else if (match[3] !== undefined) {
      segments.push({ type: 'action', text: match[3] })
    } else if (match[4] !== undefined) {
      segments.push({ type: 'dialogue', text: match[4], quote: '"' })
    } else if (match[5] !== undefined) {
      segments.push({ type: 'dialogue', text: match[5], quote: '"' })
    } else if (match[6] !== undefined) {
      segments.push({ type: 'ooc', text: match[6] })
    }
    last = TOKEN_RE.lastIndex
  }
  if (last < text.length) {
    segments.push({ type: 'normal', text: text.slice(last) })
  }
  return segments
}

function renderSegment(seg: Segment, key: number): ReactNode {
  switch (seg.type) {
    case 'bold':
      return (
        <strong key={key} className="font-semibold text-foreground">
          {seg.text}
        </strong>
      )
    case 'action':
      return (
        <em key={key} className="italic text-muted-foreground">
          {seg.text}
        </em>
      )
    case 'dialogue':
      return (
        <span key={key} className="font-medium text-primary">
          {seg.quote}
          {seg.text}
          {seg.quote === '"' ? '"' : seg.quote === '"' ? '"' : '"'}
        </span>
      )
    case 'ooc':
      return (
        <span key={key} className="text-xs italic text-muted-foreground/50">
          ({seg.text})
        </span>
      )
    default:
      return <Fragment key={key}>{seg.text}</Fragment>
  }
}

export function MessageContent({ content }: { content: string }) {
  if (!content) return null
  const segments = tokenize(content)
  return <>{segments.map((seg, i) => renderSegment(seg, i))}</>
}
