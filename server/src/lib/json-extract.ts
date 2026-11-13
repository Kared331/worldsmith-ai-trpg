/**
 * LLM 输出 JSON 容错提取。
 *
 * 来源: NarrativeEngine-P (https://github.com/Sagesheep/NarrativeEngine-P)
 *       packages/engine/src/json/jsonExtract.ts
 * 许可: MIT License, Copyright (c) 2026 Sagesheep
 * 改动: 原样引入, 未修改逻辑; 仅调整文件名以符合本项目目录结构。
 *
 * 处理场景: 推理模型的 <think> 块 (含未闭合)、markdown 代码块、
 * 前后闲聊、以及"差一点就是合法 JSON"的破损文本 (尾逗号 / 注释 /
 * 单引号 / 截断)。对已合法的 JSON 原样透传, 避免修复逻辑破坏 URL 等内容。
 */

function stripUnclosedThinkTag(text: string): string {
  const thinkIdx = text.search(/<think\b/i)
  if (thinkIdx === -1) return text
  const jsonStart = text.indexOf('{', thinkIdx)
  const arrStart = text.indexOf('[', thinkIdx)
  let nextJson = -1
  if (jsonStart !== -1 && arrStart !== -1) nextJson = Math.min(jsonStart, arrStart)
  else if (jsonStart !== -1) nextJson = jsonStart
  else if (arrStart !== -1) nextJson = arrStart
  if (nextJson === -1) return ''
  return text.slice(0, thinkIdx) + text.slice(nextJson)
}

export function extractJsonRobust<T>(raw: string, fallback: T): { value: T; parseOk: boolean } {
  let clean = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, '')
  clean = stripUnclosedThinkTag(clean)
  const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (mdMatch) clean = mdMatch[1]

  const openBrace = clean.indexOf('{')
  const openBracket = clean.indexOf('[')

  let start: number
  if (openBrace === -1 && openBracket === -1) {
    return { value: fallback, parseOk: false }
  } else if (openBrace === -1) {
    start = openBracket
  } else if (openBracket === -1) {
    start = openBrace
  } else {
    const isArray = openBracket < openBrace
    start = isArray ? openBracket : openBrace
  }

  const text = clean.slice(start)

  try {
    return { value: JSON.parse(text) as T, parseOk: true }
  } catch {
    // 响应被截断 — 尝试恢复
    let depth = 0
    let inString = false
    let escape = false
    const candidates: { pos: number; depth: number }[] = []
    let rootClosedAt = -1

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{' || ch === '[') depth++
      if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) {
          rootClosedAt = i
          break
        }
        candidates.push({ pos: i, depth })
      }
      if (ch === ',' && depth === 1) {
        candidates.push({ pos: i - 1, depth })
      }
    }

    // 尝试 1: 根节点已闭合的前缀本身就是合法 JSON
    if (rootClosedAt > 0) {
      try {
        return { value: JSON.parse(text.slice(0, rootClosedAt + 1)) as T, parseOk: true }
      } catch {
        /* 继续尝试 */
      }
    }

    // 尝试 2: 逐个候选位置截断 + 补齐未闭合括号
    for (let ci = candidates.length - 1; ci >= 0; ci--) {
      const { pos } = candidates[ci]
      const openBrackets: string[] = []
      let inStr = false
      let esc = false
      for (let j = 0; j <= pos; j++) {
        const c = text[j]
        if (esc) {
          esc = false
          continue
        }
        if (c === '\\' && inStr) {
          esc = true
          continue
        }
        if (c === '"') {
          inStr = !inStr
          continue
        }
        if (inStr) continue
        if (c === '{' || c === '[') openBrackets.push(c)
        if (c === '}' || c === ']') openBrackets.pop()
      }
      const closeStr = openBrackets
        .reverse()
        .map((b) => (b === '{' ? '}' : ']'))
        .join('')
      const recovered = text.slice(0, pos + 1) + closeStr
      try {
        return { value: JSON.parse(recovered) as T, parseOk: true }
      } catch {
        /* 尝试下一个候选 */
      }
    }

    return { value: fallback, parseOk: false }
  }
}

/**
 * 对"接近 JSON"的文本做尽力修复: 尾逗号、// 与块注释、单引号值、
 * 字符串内的裸控制字符、"}{" 粘连。只对已经 JSON.parse 失败的文本调用。
 */
function repairJson(str: string): string {
  let r = str

  r = r.replace(/,\s*([}\]])/g, '$1')

  r = r.replace(/\/\/[^\n]*/g, '')

  r = r.replace(/\/\*[\s\S]*?\*\//g, '')

  r = r.replace(/:\s*'"([^']*)'([,}\]])/g, ': "$1"$2')
  r = r.replace(/:\s*'([^']*)'([,}\]])/g, ': "$1"$2')
  r = r.replace(/\[\s*'/g, '["')
  r = r.replace(/'\s*,\s*'/g, '", "')
  r = r.replace(/'\s*]/g, '"]')
  r = r.replace(/"\s*:\s*'([^']*(?:\\.[^']*)*)'\s*([,}\]])/g, '"$1"$2')

  let inString = false
  let escaped = false
  let result = ''
  for (let i = 0; i < r.length; i++) {
    const ch = r[i]
    if (escaped) {
      result += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      result += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }
    if (inString) {
      if (ch === '\n') {
        result += '\\n'
        continue
      }
      if (ch === '\r') {
        result += '\\r'
        continue
      }
      if (ch === '\t') {
        result += '\\t'
        continue
      }
      if (ch === '\x00') {
        continue
      }
    }
    result += ch
  }
  r = result

  r = r.replace(/\}\s*\{/g, '},{')

  return r.trim()
}

/** 已合法则原样返回; 否则走 repairJson。 */
function repairIfBroken(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return trimmed
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    return repairJson(trimmed)
  }
}

/**
 * 从任意文本中提取首个 JSON 对象或数组。
 * 处理 <think> 标签、markdown 代码块、前后闲聊与可修复的破损 JSON。
 */
export function extractJson(text: string): string {
  let clean = text.replace(/<think[\s\S]*?<\/think\s*>/gi, '')
  clean = stripUnclosedThinkTag(clean)

  const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (markdownMatch) {
    clean = markdownMatch[1]
  }

  const firstObj = clean.indexOf('{')
  const firstArr = clean.indexOf('[')
  const start = firstObj !== -1 && (firstArr === -1 || firstObj < firstArr) ? firstObj : firstArr

  if (start !== -1) {
    const lastObj = clean.lastIndexOf('}')
    const lastArr = clean.lastIndexOf(']')
    const end = lastObj !== -1 && (lastArr === -1 || lastObj > lastArr) ? lastObj : lastArr

    if (end !== -1 && end > start) {
      return repairIfBroken(clean.substring(start, end + 1))
    }
  }

  return repairIfBroken(clean)
}
