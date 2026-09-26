import type { Completion, CompletionRequest } from './port.ts'

/**
 * 模型 provider。
 *
 * 两种线协议：Anthropic Messages 与 OpenAI Chat Completions。
 * 结构化输出一律走工具调用——比让模型"输出 JSON"可靠得多，
 * 且两家的工具调用语义足够接近，可以共用一套上层代码。
 */

export interface ProviderConfig {
  /** 'anthropic' | 'openai'。公司内网 vLLM 走 openai。 */
  wire: 'anthropic' | 'openai'
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  /** 额外的请求头，比如某些网关要求的标识。 */
  headers?: Record<string, string>
}

export class LlmError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`模型调用失败 (HTTP ${status}): ${body.slice(0, 300)}`)
    this.name = 'LlmError'
    this.status = status
    this.body = body
  }
}

export function createProvider(config: ProviderConfig) {
  return {
    async complete(req: CompletionRequest): Promise<Completion> {
      return config.wire === 'anthropic' ? anthropic(config, req) : openai(config, req)
    },
  }
}

// ── Anthropic Messages ───────────────────────────────────────

async function anthropic(cfg: ProviderConfig, req: CompletionRequest): Promise<Completion> {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? 8192,
    messages: req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
  }
  if (system !== '') body.system = system

  if (req.schema !== undefined) {
    body.tools = [
      {
        name: req.schema.name,
        description: req.schema.description,
        input_schema: req.schema.parameters,
      },
    ]
    // 强制走这个工具：否则模型可能用自然语言回答，结构化输出就落空了
    body.tool_choice = { type: 'tool', name: req.schema.name }
  }

  const res = await post(cfg, '/v1/messages', body, {
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  }, req.signal)

  const json = res as {
    content?: Array<{ type: string; text?: string; input?: unknown }>
    model?: string
  }

  const blocks = json.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  const toolUse = blocks.find((b) => b.type === 'tool_use')

  return {
    text,
    ...(toolUse?.input !== undefined ? { structured: toolUse.input } : {}),
    model: json.model ?? cfg.model,
  }
}

// ── OpenAI Chat Completions ──────────────────────────────────

async function openai(cfg: ProviderConfig, req: CompletionRequest): Promise<Completion> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? 8192,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  }

  if (req.schema !== undefined) {
    body.tools = [
      {
        type: 'function',
        function: {
          name: req.schema.name,
          description: req.schema.description,
          parameters: req.schema.parameters,
        },
      },
    ]
    body.tool_choice = { type: 'function', function: { name: req.schema.name } }
  }

  const res = await post(
    cfg,
    '/v1/chat/completions',
    body,
    { authorization: `Bearer ${cfg.apiKey}` },
    req.signal,
  )

  const json = res as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ function?: { arguments?: string } }>
      }
    }>
    model?: string
  }

  const msg = json.choices?.[0]?.message
  const rawArgs = msg?.tool_calls?.[0]?.function?.arguments

  let structured: unknown
  if (typeof rawArgs === 'string') {
    try {
      structured = JSON.parse(rawArgs)
    } catch (e) {
      // 开放权重模型偶尔产出不合法 JSON。明确报错，不吞掉——
      // 上层需要知道是"模型没按格式回"而不是"没有结果"。
      throw new LlmError(200, `工具调用参数不是合法 JSON: ${String(e)}\n${rawArgs.slice(0, 500)}`)
    }
  }

  return {
    text: msg?.content ?? '',
    ...(structured !== undefined ? { structured } : {}),
    model: json.model ?? cfg.model,
  }
}

// ── 共用 ─────────────────────────────────────────────────────

async function post(
  cfg: ProviderConfig,
  path: string,
  body: unknown,
  auth: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + path

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, ...cfg.headers },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  })

  const text = await res.text()
  if (!res.ok) throw new LlmError(res.status, text)

  try {
    return JSON.parse(text)
  } catch {
    throw new LlmError(res.status, `响应不是合法 JSON: ${text.slice(0, 300)}`)
  }
}
