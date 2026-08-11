import { resolveRole, type ResolvedEndpoint } from './config.js'
import type { LlmRole } from '@worldsmith/shared'

// ============================================================
// LLM 适配层: OpenAI 兼容端点 (openai/deepseek/ollama/通义/Kimi...)
//            + Anthropic 原生格式 (v1/messages)
// ============================================================

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOpts {
  endpoint?: ResolvedEndpoint
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  text: string
  toolCalls: ToolCall[]
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

function baseHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (endpoint.apiKey) h.Authorization = `Bearer ${endpoint.apiKey}`
  return h
}

/** OpenAI 兼容 SSE 解析: 逐 chunk 产出 content delta */
async function* streamOpenAICompat(
  res: Response,
): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const delta = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) yield delta
      } catch {
        // 忽略无法解析的 keep-alive 等行
      }
    }
  }
}

/** Anthropic 原生 SSE 解析: event: content_block_delta → data: {delta:{text}} */
async function* streamAnthropic(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let currentEvent = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.slice(6).trim()
        continue
      }
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      try {
        const json = JSON.parse(payload) as { delta?: { text?: string } }
        if (currentEvent === 'content_block_delta' && json.delta?.text) {
          yield json.delta.text
        }
      } catch {
        // 忽略
      }
    }
  }
}

async function requestOpenAICompat(
  endpoint: ResolvedEndpoint,
  messages: ChatMsg[],
  opts: ChatOpts,
): Promise<Response> {
  return fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: baseHeaders(endpoint),
    body: JSON.stringify({
      model: endpoint.modelId,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true,
    }),
    signal: opts.signal,
  })
}

async function requestAnthropic(
  endpoint: ResolvedEndpoint,
  messages: ChatMsg[],
  opts: ChatOpts,
): Promise<Response> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system')
  return fetch(`${endpoint.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': endpoint.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: endpoint.modelId,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.8,
      stream: true,
      system: system || undefined,
      messages: rest,
    }),
    signal: opts.signal,
  })
}

async function ensureOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new LlmError(
      `LLM request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
      res.status,
      body,
    )
  }
}

/** 流式对话: 逐 chunk 产出文本增量 */
export async function* streamChat(
  messages: ChatMsg[],
  opts: ChatOpts = {},
): AsyncGenerator<string> {
  const endpoint = opts.endpoint ?? resolveRole('character')
  if (!endpoint.apiKey && endpoint.providerId !== 'ollama') {
    throw new LlmError(`no apiKey for provider "${endpoint.providerId}" (set ${endpoint.apiKey || 'env var'} in llm.config.json / .env)`)
  }
  const res =
    endpoint.providerId === 'anthropic'
      ? await requestAnthropic(endpoint, messages, opts)
      : await requestOpenAICompat(endpoint, messages, opts)
  await ensureOk(res)
  if (endpoint.providerId === 'anthropic') {
    for await (const chunk of streamAnthropic(res)) yield chunk
  } else {
    for await (const chunk of streamOpenAICompat(res)) yield chunk
  }
}

/** 非流式对话 (完整文本) */
export async function chat(
  messages: ChatMsg[],
  opts: ChatOpts = {},
): Promise<string> {
  let acc = ''
  for await (const chunk of streamChat(messages, opts)) acc += chunk
  return acc
}

/**
 * 工具调用对话 (非流式): 支持 function calling
 * 注: 仅 OpenAI 兼容端点支持; Anthropic 原生格式暂不支持工具 (Phase 2)
 */
export async function chatWithTools(
  messages: unknown[],
  tools: ToolDef[],
  opts: ChatOpts = {},
): Promise<ToolResult> {
  const endpoint = opts.endpoint ?? resolveRole('character')
  if (endpoint.providerId === 'anthropic') {
    throw new LlmError('tool calling is not supported for anthropic provider yet')
  }
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: baseHeaders(endpoint),
    body: JSON.stringify({
      model: endpoint.modelId,
      messages,
      tools: tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 2048,
    }),
    signal: opts.signal,
  })
  await ensureOk(res)
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{
          id: string
          function: { name: string; arguments: string }
        }>
      }
    }>
  }
  const msg = data.choices?.[0]?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJson(tc.function.arguments),
  }))
  return { text: msg?.content ?? '', toolCalls }
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 文本嵌入 (OpenAI 兼容 /embeddings) */
export async function createEmbedding(
  text: string,
  endpoint?: ResolvedEndpoint,
): Promise<number[]> {
  const ep = endpoint ?? resolveRole('embedding')
  const res = await fetch(`${ep.baseUrl}/embeddings`, {
    method: 'POST',
    headers: baseHeaders(ep),
    body: JSON.stringify({ model: ep.modelId, input: text }),
  })
  await ensureOk(res)
  const data = (await res.json()) as {
    data?: Array<{ embedding: number[] }>
  }
  const emb = data.data?.[0]?.embedding
  if (!emb) throw new LlmError('embedding response missing data[0].embedding')
  return emb
}

export type { LlmRole }
