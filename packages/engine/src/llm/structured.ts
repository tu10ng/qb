/**
 * 统一的流式结构化调用。
 *
 * 所有模型行为都走这一个函数：streamText + Output.object(zod)。
 * 部分结果经 onPartial 推给界面，最终结果按 schema 校验。
 *
 * 实测（docs/adr/0002）兼容端点上的模型会有三种输出习惯导致校验失败：
 * 只输出第一个字段就停、编出枚举外的值、漏掉必填字段。后两种由 schema
 * 里的 .catch() 兜住；第一种重试一次通常就好。
 */

import { APICallError, NoObjectGeneratedError, Output, streamText } from 'ai'
import { z } from 'zod'
import type { BoundModel } from './models.ts'
import type { ModelProfile } from './profiles.ts'
import { LlmError, type StructuredCall, type StructuredResult } from './port.ts'

/** 输出不合格时的最多尝试次数（含第一次）。 */
const MAX_ATTEMPTS = 2

export async function runStructured<T>(
  bound: BoundModel,
  profile: ModelProfile,
  call: StructuredCall<T>,
): Promise<StructuredResult<T>> {
  const started = Date.now()
  let lastShapeError: unknown = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(profile.options.timeoutMs)
    const signal = call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout])
    let streamError: unknown = null

    const result = streamText({
      model: bound.model,
      system: bound.injectSchema ? `${call.system}\n\n${schemaInstruction(call.schema)}` : call.system,
      messages: [{ role: 'user', content: userContent(call) }],
      output: Output.object({ schema: call.schema, name: call.name }),
      providerOptions: bound.structuredOptions as never,
      maxOutputTokens: profile.options.maxOutputTokens,
      abortSignal: signal,
      // 网络层的瞬时失败交给 SDK 重试一次；输出不合格的重试在下面自己做
      maxRetries: 1,
      onError: ({ error }) => {
        streamError = error
      },
    })

    try {
      for await (const partial of result.partialOutputStream) call.onPartial?.(partial)
      const output = await result.output
      const response = await result.response
      return {
        output,
        model: response.modelId || profile.model,
        profileName: profile.name,
        attempts: attempt,
        ms: Date.now() - started,
      }
    } catch (e) {
      if (call.signal?.aborted === true) throw new LlmError('cancelled', '调用已取消')
      if (timeout.aborted) {
        throw new LlmError(
          'timeout',
          `${label(profile)} ${Math.round(profile.options.timeoutMs / 1000)} 秒内没有返回。` +
            `如果开着思考，关掉它通常快 5–10 倍。`,
        )
      }
      const err = streamError ?? e
      if (isShapeError(err) && attempt < MAX_ATTEMPTS) {
        lastShapeError = err
        continue
      }
      throw toLlmError(err, profile)
    }
  }

  throw toLlmError(lastShapeError, profile)
}

function userContent<T>(call: StructuredCall<T>) {
  if (call.images === undefined || call.images.length === 0) return call.prompt
  return [
    { type: 'text' as const, text: call.prompt },
    ...call.images.map((img) => ({ type: 'file' as const, data: img.data, mediaType: img.mediaType })),
  ]
}

/** 端点只保证"输出是 JSON"时，把 schema 写进系统提示。 */
function schemaInstruction(schema: z.ZodType): string {
  return (
    '只输出一个 JSON 对象，不要输出任何其他文字。它必须符合下面的 JSON Schema：\n' +
    JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))
  )
}

function isShapeError(e: unknown): boolean {
  return NoObjectGeneratedError.isInstance(e)
}

function label(profile: ModelProfile): string {
  return `[${profile.name} · ${profile.model}]`
}

/**
 * 把 SDK 与网络错误翻译成人能照着做的话。
 *
 * 只取响应体的开头一段：够判断原因，又不会把整页 HTML 错误页塞给用户。
 * 请求头（含密钥）从不进入错误信息。
 */
export function toLlmError(e: unknown, profile: ModelProfile): LlmError {
  if (e instanceof LlmError) return e
  const who = label(profile)

  if (NoObjectGeneratedError.isInstance(e)) {
    const said = (e.text ?? '').replace(/\s+/g, ' ').slice(0, 200)
    return new LlmError(
      'shape',
      `${who} 输出不符合要求的格式（已重试一次）。` + (said !== '' ? `它输出的开头是：${said}` : ''),
    )
  }

  if (APICallError.isInstance(e)) {
    const status = e.statusCode ?? null
    const body = (e.responseBody ?? e.message).replace(/\s+/g, ' ').slice(0, 300)

    if (status === 401 || status === 403) {
      return new LlmError('auth', `${who} 密钥无效或没有权限（HTTP ${status}）。到设置里检查 key。`, status)
    }
    if (status === 404) {
      return new LlmError('not_found', `${who} 地址或模型名不对（HTTP 404）：${body}`, status)
    }
    if (status === 400 && /thinking/i.test(body) && /tool_choice/i.test(body)) {
      return new LlmError(
        'thinking_conflict',
        `${who} 开着思考时不支持强制结构化输出。到设置里把"思考"关掉。`,
        status,
      )
    }
    if (status === 429) {
      return new LlmError('rate_limit', `${who} 请求太频繁或额度用完（HTTP 429）：${body}`, status)
    }
    if (status !== null && status >= 500) {
      return new LlmError('server', `${who} 模型服务出错（HTTP ${status}）：${body}`, status)
    }
    if (status !== null) {
      return new LlmError('rejected', `${who} 请求被拒绝（HTTP ${status}）：${body}`, status)
    }
    return new LlmError('network', `${who} 连不上 ${hostOf(profile.baseUrl)}：${causeOf(e)}`)
  }

  if (e instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket/i.test(`${e.message} ${causeOf(e)}`)) {
    return new LlmError('network', `${who} 连不上 ${hostOf(profile.baseUrl)}：${causeOf(e)}`)
  }

  return new LlmError('rejected', `${who} 调用失败：${e instanceof Error ? e.message : String(e)}`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function causeOf(e: unknown): string {
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error) return cause.message
  return e instanceof Error ? e.message : String(e)
}
