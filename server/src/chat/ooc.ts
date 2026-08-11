// ============================================================
// OOC (Out Of Character) 检测器: 规则扫描 + 格式清洗
// ============================================================

const OOC_PATTERNS: RegExp[] = [
  // 中文出戏特征
  /作为(一个)?(人工智能|AI助手|AI|语言模型|智能助手)[，,。:：\s]/,
  /我是(一个)?(人工智能|AI助手|AI|语言模型|虚拟助手|智能助手)/,
  /我是一个(人工智能|语言模型|AI)/,
  /(我|人家|本)[的]?(角色|设定)中/,
  /抱歉[，,]?我(不能|无法|只是)/,
  /对不起[，,]?我(不能|无法|只是)/,
  /我不能(满足|提供|完成|继续|帮助|回答)你/,
  /作为[一]?个?AI助手/,
  // 英文出戏特征
  /\bas an (AI|assistant|language model)\b/i,
  /\bI'?m (an )?(AI|language model|virtual assistant)\b/i,
  /\bI am (an )?(AI|language model)\b/i,
]

export interface OocReport {
  /** 命中的规则 (正则源码) */
  matched: string[]
  /** 清洗后的文本 */
  clean: string
}

/** 检测文本是否出戏 */
export function detectOoc(text: string): OocReport {
  const matched = OOC_PATTERNS.filter((p) => p.test(text)).map((p) => p.source)
  return { matched, clean: sanitize(text) }
}

/** 格式清洗: 移除 markdown 代码块 / JSON 残留 / 多余空白 */
export function sanitize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, (m) => {
      // 仅当看起来是 JSON 对象时移除
      return /"[a-zA-Z_]+"\s*:/.test(m) ? '' : m
    })
    .replace(/^\s*[#>*-]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
