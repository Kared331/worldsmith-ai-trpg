import { PNG } from 'pngjs'
import zlib from 'node:zlib'

// ============================================================
// PNG 角色卡 (SillyTavern / Chub 兼容):
// PNG tEXt chunk 中嵌入 base64 的 JSON 角色数据
//   - "ccv3": Character Card V3 (字段统一在 data 下)
//   - "chara": Character Card V2 (字段可在顶层, 也可在 data 下)
// 读取优先 V3; 导出时同时写两个 chunk, 保证新旧客户端都能识别
// ============================================================

/** SillyTavern 角色卡格式 (归一化后的扁平结构) */
export interface CharCardV2 {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example?: string
  creator_notes?: string
  [key: string]: unknown
}

/** 带 text 扩展的 PNG 类型 (pngjs 运行时支持 tEXt chunk) */
type PngWithText = PNG & { text?: Record<string, string> }

const CHARA_KEY = 'chara'
const CCV3_KEY = 'ccv3'

/**
 * 统一 V3 / V2 的数据层级。
 * V3 规范把字段一律放在 data 下; V2 也允许 data 包装。
 * 这里把 data 合并到顶层, 让字段读取方只面对一套结构。
 */
function normalizeCard(card: unknown): CharCardV2 | null {
  if (!card || typeof card !== 'object') return null
  const obj = card as Record<string, unknown>
  const data =
    obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : null
  return (data ? { ...obj, ...data } : obj) as CharCardV2
}

/**
 * 从 PNG buffer 读取角色卡 (找不到返回 null)
 * 注: pngjs 不解析 tEXt chunk, 这里手动扫描 chunk 链
 */
export function readCharCard(buffer: Buffer): CharCardV2 | null {
  // 校验 PNG 有效性
  try {
    PNG.sync.read(buffer)
  } catch {
    return null
  }
  let offset = 8
  const found: Record<string, string> = {}
  while (offset + 12 <= buffer.length) {
    const len = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'tEXt') {
      const data = buffer.subarray(offset + 8, offset + 8 + len)
      const nul = data.indexOf(0)
      if (nul !== -1) {
        const key = data.subarray(0, nul).toString('utf-8')
        if (key === CHARA_KEY || key === CCV3_KEY) {
          found[key] = data.subarray(nul + 1).toString('utf-8')
        }
      }
    }
    offset += 12 + len
  }

  // V3 优先, 回退 V2
  const raw = found[CCV3_KEY] ?? found[CHARA_KEY]
  if (!raw) return null
  try {
    return normalizeCard(JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')))
  } catch {
    return null
  }
}

/** 构造一个 PNG chunk (length + type + data + crc32) */
function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/** 在第一个 IDAT chunk 前插入 tEXt chunk */
function injectTextChunk(png: Buffer, textChunk: Buffer): Buffer {
  const out: Buffer[] = [png.subarray(0, 8)]
  let offset = 8
  let inserted = false
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const chunkType = png.subarray(offset + 4, offset + 8).toString('ascii')
    if (chunkType === 'IDAT' && !inserted) {
      out.push(textChunk)
      inserted = true
    }
    out.push(png.subarray(offset, offset + 12 + len))
    offset += 12 + len
  }
  return Buffer.concat(out)
}

/** 编码一个 tEXt chunk 载荷: key\0base64(json) */
function encodeText(key: string, value: unknown): Buffer {
  return Buffer.concat([
    Buffer.from(key + '\u0000', 'utf-8'),
    Buffer.from(Buffer.from(JSON.stringify(value)).toString('base64'), 'utf-8'),
  ])
}

/** 生成带角色卡 chunk 的 PNG (无头像时生成 1x1 占位像素) */
export function writeCharCard(card: CharCardV2, avatar?: Buffer | null): Buffer {
  const png = new PNG({
    width: avatar ? 256 : 1,
    height: avatar ? 256 : 1,
  })
  if (avatar) {
    // 把头像像素拷贝到 png (头像需为 RGBA)
    const src = PNG.sync.read(avatar)
    const size = Math.min(src.width, src.height, 256)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const si = (y * src.width + x) * 4
        const di = (y * png.width + x) * 4
        png.data[di] = src.data[si]
        png.data[di + 1] = src.data[si + 1]
        png.data[di + 2] = src.data[si + 2]
        png.data[di + 3] = src.data[si + 3]
      }
    }
  }
  const base = PNG.sync.write(png)
  // 同时写 V2(chara) 与 V3(ccv3): 老客户端读前者, SillyTavern 等新客户端优先读后者
  const v3Card = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...card } }
  const textChunk = Buffer.concat([
    makeChunk('tEXt', encodeText(CHARA_KEY, card)),
    makeChunk('tEXt', encodeText(CCV3_KEY, v3Card)),
  ])
  return injectTextChunk(base, textChunk)
}

/** worldsmith 角色 → CharCardV2 */
export function toCharCard(input: {
  name: string
  personality: string
  background: string
  scenario?: string | null
  firstMessage?: string | null
}): CharCardV2 {
  return {
    name: input.name,
    description: input.background,
    personality: input.personality,
    scenario: input.scenario ?? '',
    first_mes: input.firstMessage ?? '',
    spec: 'chara_card_v2',
    spec_version: '2.0',
  }
}

/** CharCardV2 → worldsmith 角色字段 */
export function fromCharCard(card: CharCardV2): {
  name: string
  personality: string
  background: string
  scenario: string
  firstMessage: string
} {
  return {
    name: card.name || '未命名角色',
    personality: card.personality ?? '',
    background: card.description ?? '',
    scenario: card.scenario ?? '',
    firstMessage: card.first_mes ?? '',
  }
}
