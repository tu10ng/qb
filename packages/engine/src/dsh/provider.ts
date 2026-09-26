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
  /**
   * 输出上限。推理型模型（GLM、带 thinking 的 Claude）光思考就可能
   * 花掉三万字符，起草这类重调用要给足预算。
   */
  maxTokens?: number
  /** 单次调用超时，默认 240 秒。 */
  timeoutMs?: number
  /** 额外的请求头，比如某些网关要求的标识。 */
  headers?: Record<string, string>
}

/** 兜底输出上限。够一份 runbook 加上推理型模型的思考过程。 */
const DEFAULT_MAX_TOKENS = 32768

/**
 * 单次调用的超时。
 *
 * 实测 GLM-5.3 起草一份 20 步的 runbook 要 4 分钟以上（思考量在
 * 7k~52k 字符间波动）。起草是后台任务，等久一点没有代价；真正要
 * 避免的是网络层默认超时抛出无信息的 "fetch failed"。
 */
const DEFAULT_TIMEOUT_MS = 480_000

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
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
    // 必须流式：推理型模型思考几分钟才出第一个字，非流式会撞上
    // Node 的 headersTimeout（5 分钟硬限，AbortSignal 管不到），
    // 抛出无信息的 "fetch failed"。流式下首字节很快就到。
    stream: true,
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

  const res = await request(
    cfg,
    '/v1/messages',
    body,
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    req.signal,
  )

  const assembled = await readAnthropicStream(res, cfg, req.signal, req.onProgress)

  // 被 max_tokens 截断时工具调用参数是残缺的 JSON，上层解析会失败
  // 且报错离源头很远。这里明确告知。
  if (assembled.stopReason === 'max_tokens' && assembled.toolInput === undefined) {
    throw new LlmError(
      200,
      `输出被 max_tokens 截断，没能完成工具调用。` +
        (assembled.thinking !== '' ? `模型在思考阶段消耗了 ${assembled.thinking.length} 字符。` : '') +
        `提高 maxTokens 再试。`,
    )
  }

  return {
    text: assembled.text,
    ...(assembled.toolInput !== undefined ? { structured: assembled.toolInput } : {}),
    ...(assembled.thinking !== '' ? { thinking: assembled.thinking } : {}),
    model: assembled.model ?? cfg.model,
  }
}

interface Assembled {
  text: string
  thinking: string
  toolInput: unknown
  stopReason: string | null
  model: string | null
}

/**
 * 读 Anthropic 的 SSE 流并拼回完整结果。
 *
 * 工具调用参数是分片到达的 JSON 文本（input_json_delta），要拼完整
 * 再解析。thinking 块也分片。
 */
async function readAnthropicStream(
  res: Response,
  cfg: ProviderConfig,
  signal: AbortSignal | undefined,
  onProgress: CompletionRequest['onProgress'],
): Promise<Assembled> {
  let text = ''
  let thinking = ''
  let toolJson = ''
  let stopReason: string | null = null
  let model: string | null = null

  for await (const event of sseEvents(res, signal)) {
    const type = event.type as string

    if (type === 'message_start') {
      const msg = event.message as { model?: string } | undefined
      model = msg?.model ?? null
    } else if (type === 'content_block_delta') {
      const d = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string }
      if (d.type === 'text_delta' && d.text !== undefined) text += d.text
      else if (d.type === 'thinking_delta' && d.thinking !== undefined) {
        thinking += d.thinking
        onProgress?.({ kind: 'thinking', chars: thinking.length })
      } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
        toolJson += d.partial_json
        onProgress?.({ kind: 'writing', chars: toolJson.length })
      }
    } else if (type === 'message_delta') {
      const d = event.delta as { stop_reason?: string } | undefined
      if (d?.stop_reason !== undefined) stopReason = d.stop_reason
    } else if (type === 'error') {
      const err = event.error as { message?: string } | undefined
      throw new LlmError(200, err?.message ?? '模型返回了错误事件')
    }
  }

  let toolInput: unknown
  if (toolJson !== '') {
    try {
      toolInput = JSON.parse(toolJson)
    } catch (e) {
      // 截断的话上面已经给出更准确的提示；这里是真的格式不对
      throw new LlmError(
        200,
        `工具调用参数不是合法 JSON（${cfg.model}）：${String(e)}\n${toolJson.slice(-400)}`,
      )
    }
  }

  return { text, thinking, toolInput, stopReason, model }
}

/** 逐个产出 SSE 事件的 data 部分。 */
async function* sseEvents(
  res: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const body = res.body
  if (body === null) throw new LlmError(res.status, '流式响应没有 body')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted === true) throw new LlmError(499, '调用已取消')

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue
          try {
            yield JSON.parse(payload) as Record<string, unknown>
          } catch {
            // 单个事件解析失败不该中断整个流
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── OpenAI Chat Completions ──────────────────────────────────

async function openai(cfg: ProviderConfig, req: CompletionRequest): Promise<Completion> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    // 同 anthropic 分支：非流式会撞上 Node 的 headersTimeout 硬限
    stream: true,
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

  const res = await request(
    cfg,
    '/v1/chat/completions',
    body,
    { authorization: `Bearer ${cfg.apiKey}` },
    req.signal,
  )

  let text = ''
  let toolJson = ''
  let reasoning = ''
  let model: string | null = null
  let finishReason: string | null = null

  for await (const event of sseEvents(res, req.signal)) {
    if (typeof event.model === 'string') model = event.model

    const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0]
    if (choice === undefined) continue

    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

    const delta = choice.delta as
      | {
          content?: string | null
          reasoning_content?: string | null
          tool_calls?: Array<{ function?: { arguments?: string } }>
        }
      | undefined
    if (delta === undefined) continue

    if (typeof delta.content === 'string') text += delta.content
    // DeepSeek-R1 等模型把思考过程放在 reasoning_content
    if (typeof delta.reasoning_content === 'string') {
      reasoning += delta.reasoning_content
      req.onProgress?.({ kind: 'thinking', chars: reasoning.length })
    }

    const args = delta.tool_calls?.[0]?.function?.arguments
    if (typeof args === 'string') {
      toolJson += args
      req.onProgress?.({ kind: 'writing', chars: toolJson.length })
    }
  }

  if (finishReason === 'length' && toolJson === '') {
    throw new LlmError(
      200,
      `输出被 max_tokens 截断，没能完成工具调用。` +
        (reasoning !== '' ? `模型在思考阶段消耗了 ${reasoning.length} 字符。` : '') +
        `提高 maxTokens 再试。`,
    )
  }

  let structured: unknown
  if (toolJson !== '') {
    try {
      structured = JSON.parse(toolJson)
    } catch (e) {
      // 开放权重模型偶尔产出不合法 JSON。明确报错，不吞掉——
      // 上层需要知道是"模型没按格式回"而不是"没有结果"。
      throw new LlmError(
        200,
        `工具调用参数不是合法 JSON（${cfg.model}）：${String(e)}
${toolJson.slice(-400)}`,
      )
    }
  }

  return {
    text,
    ...(structured !== undefined ? { structured } : {}),
    ...(reasoning !== '' ? { thinking: reasoning } : {}),
    model: model ?? cfg.model,
  }
}

// ── 共用 ─────────────────────────────────────────────────────

/**
 * 发起流式请求，返回未读的 Response。
 *
 * 超时靠 AbortSignal 控制：Node 的默认行为是抛无信息的 "fetch failed"，
 * 用户等了几分钟却不知道是网络断了、模型太慢，还是密钥不对。
 */
async function request(
  cfg: ProviderConfig,
  path: string,
  body: unknown,
  auth: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + path
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const timer = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timer : AbortSignal.any([signal, timer])

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...auth, ...cfg.headers },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (e) {
    if (timer.aborted) {
      throw new LlmError(
        408,
        `模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回。` +
          `推理型模型起草复杂任务较慢，可以把任务描述写得更具体些，或换个更快的模型。`,
      )
    }
    if (signal?.aborted === true) throw new LlmError(499, '调用已取消')
    throw new LlmError(
      0,
      `连接失败：${e instanceof Error ? e.message : String(e)}（检查端点地址与网络）`,
    )
  }

  if (!res.ok) {
    throw new LlmError(res.status, await res.text())
  }
  return res
}
