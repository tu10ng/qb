import { APICallError } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BoundModel } from '../src/llm/models.ts'
import { ProfileOptions, type ModelProfile } from '../src/llm/profiles.ts'
import { LlmError } from '../src/llm/port.ts'
import { runStructured } from '../src/llm/structured.ts'

/**
 * 统一结构化调用的行为：流式部分结果、宽容校验、结构性失败重试一次、
 * 错误翻译。模型用 AI SDK 自带的 MockLanguageModelV4，走真实的 SDK 管线。
 */

const profile: ModelProfile = {
  id: 'p1',
  name: '测试档案',
  preset: 'deepseek',
  wire: 'anthropic',
  baseUrl: 'https://api.example.com/anthropic',
  apiKey: 'sk-secret-should-never-appear',
  model: 'test-model',
  options: ProfileOptions.parse({ timeoutMs: 5_000 }),
  capabilities: null,
  source: 'local',
  updatedAt: 0,
}

const Schema = z.object({
  steps: z.array(
    z
      .object({ title: z.string(), kind: z.enum(['command', 'manual']).catch('manual') })
      .nullable()
      .catch(null),
  ),
})

/** 把一段 JSON 文本切成若干 text-delta，模拟模型逐字吐出。 */
function streamOf(json: string, pieces = 4) {
  const size = Math.ceil(json.length / pieces)
  const deltas = Array.from({ length: pieces }, (_, i) => json.slice(i * size, (i + 1) * size)).filter(Boolean)
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'response-metadata' as const, id: 'r1', modelId: 'test-model-2026', timestamp: new Date(0) },
      { type: 'text-start' as const, id: 't1' },
      ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
      { type: 'text-end' as const, id: 't1' },
      {
        type: 'finish' as const,
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
      },
    ]),
  }
}

function bound(model: MockLanguageModelV4): BoundModel {
  return { model, structuredOptions: {}, textOptions: {}, injectSchema: false }
}

const call = (onPartial?: (p: unknown) => void) => ({
  purpose: 'structure' as const,
  name: 'runbook',
  system: '你是 QB。',
  prompt: '起草',
  schema: Schema,
  ...(onPartial !== undefined ? { onPartial } : {}),
})

describe('runStructured', () => {
  it('流式给出部分结果，最终按 schema 校验', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf(JSON.stringify({ steps: [{ title: 'a', kind: 'command' }, { title: 'b', kind: 'command' }] }), 6),
    })
    const partials: unknown[] = []
    const r = await runStructured(bound(model), profile, call((p) => partials.push(p)))

    expect(r.output.steps).toEqual([
      { title: 'a', kind: 'command' },
      { title: 'b', kind: 'command' },
    ])
    expect(partials.length).toBeGreaterThan(1)
    expect(r.attempts).toBe(1)
    expect(r.model).toBe('test-model-2026')
    expect(r.profileName).toBe('测试档案')
  })

  it('宽容校验：枚举外的值兜底、坏的单项丢成 null，不废掉整份', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf(JSON.stringify({ steps: [{ title: 'a', kind: 'shell' }, { nope: 1 }] })),
    })
    const r = await runStructured(bound(model), profile, call())
    expect(r.output.steps).toEqual([{ title: 'a', kind: 'manual' }, null])
  })

  it('结构性失败（缺顶层字段）时重试一次', async () => {
    // 实测 v4-pro 偶尔只输出第一个字段就停
    const model = new MockLanguageModelV4({
      doStream: [streamOf(JSON.stringify({ assumptions: [] })), streamOf(JSON.stringify({ steps: [{ title: 'ok', kind: 'command' }] }))],
    })
    const r = await runStructured(bound(model), profile, call())
    expect(r.attempts).toBe(2)
    expect(r.output.steps).toEqual([{ title: 'ok', kind: 'command' }])
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('重试后仍不合格：报 shape 错误并带上模型输出的开头', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf('我觉得需要更多信息才能起草'), streamOf('还是需要更多信息')],
    })
    const err = await runStructured(bound(model), profile, call()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('shape')
    expect((err as LlmError).message).toContain('还是需要更多信息')
    expect((err as LlmError).message).toContain('测试档案')
  })

  it('思考模式与强制结构化冲突时给出能照做的提示', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: 'Bad Request',
          url: 'https://api.example.com/anthropic/v1/messages',
          requestBodyValues: {},
          statusCode: 400,
          responseBody: '{"error":{"message":"Thinking mode does not support this tool_choice"}}',
          isRetryable: false,
        })
      },
    })
    const err = (await runStructured(bound(model), profile, call()).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('thinking_conflict')
    expect(err.message).toMatch(/关掉/)
  })

  it('401 翻译成密钥问题，且错误信息里没有密钥', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: 'Unauthorized',
          url: 'https://api.example.com/anthropic/v1/messages',
          requestBodyValues: {},
          statusCode: 401,
          responseBody: '{"error":"invalid api key"}',
          isRetryable: false,
        })
      },
    })
    const err = (await runStructured(bound(model), profile, call()).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('auth')
    expect(err.message).not.toContain(profile.apiKey)
  })

  it('超时给出明确原因', async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        await new Promise((_, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason)))
        throw new Error('unreachable')
      },
    })
    const quick = { ...profile, options: { ...profile.options, timeoutMs: 50 } }
    const err = (await runStructured(bound(model), quick, call()).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('timeout')
  })

  it('调用方取消时报 cancelled，不重试', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        controller.abort()
        await new Promise((_, reject) => {
          if (abortSignal?.aborted === true) reject(abortSignal.reason)
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason))
        })
        throw new Error('unreachable')
      },
    })
    const err = (await runStructured(bound(model), profile, { ...call(), signal: controller.signal }).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('cancelled')
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('端点只支持 json_object 时把 schema 写进系统提示', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf(JSON.stringify({ steps: [] })),
    })
    await runStructured({ ...bound(model), injectSchema: true }, profile, call())
    const system = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')
    expect(JSON.stringify(system)).toContain('JSON Schema')
  })
})
