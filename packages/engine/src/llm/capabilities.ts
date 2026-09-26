/**
 * "测试连接"：依次探明一个档案能做什么，结果存成能力档案。
 *
 * 顺序有讲究：连不上就不必再测结构化；结构化失败时要区分是"思考模式
 * 不支持强制工具"（关思考就好）还是端点根本不支持 json_schema（换
 * json_object 再试）。
 */

import { generateText } from 'ai'
import { z } from 'zod'
import { bindModel, withV1 } from './models.ts'
import type { Capabilities, JsonMode, ModelProfile, Wire } from './profiles.ts'
import { runStructured, toLlmError } from './structured.ts'

/** 32×32 的纯红 PNG：看图测试用，答案确定。 */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC',
  'base64',
)

const Probe = z.object({
  items: z.array(z.object({ title: z.string(), command: z.string() })),
})

export async function testProfile(
  profile: ModelProfile,
  report: (line: string) => void,
): Promise<Capabilities> {
  const caps: Capabilities = {
    testedAt: Date.now(),
    connect: { ok: false },
    structured: { ok: false },
    vision: { ok: false },
  }

  // 1. 连通、鉴权、模型名
  report('连通与鉴权…')
  const bound = bindModel(profile)
  let t0 = Date.now()
  try {
    const r = await generateText({
      model: bound.model,
      prompt: '只回复一个字：好',
      maxOutputTokens: 64,
      providerOptions: bound.textOptions as never,
      abortSignal: AbortSignal.timeout(60_000),
      maxRetries: 0,
    })
    caps.connect = { ok: true, ms: Date.now() - t0, detail: r.text.trim().slice(0, 40) }
  } catch (e) {
    caps.connect = { ok: false, ms: Date.now() - t0, detail: toLlmError(e, profile).message }
    return caps
  }

  // 2. 强制结构化 + 流式部分结果。OpenAI 兼容端点先试约束解码，不行再退到 json_object
  report('结构化输出与流式…')
  const modes: Array<JsonMode | undefined> = profile.wire === 'openai-compatible' ? ['json_schema', 'json_object'] : [undefined]
  for (const mode of modes) {
    t0 = Date.now()
    let partials = 0
    let firstPartialMs: number | undefined
    try {
      const res = await runStructured(bindModel(profile, mode === undefined ? {} : { jsonMode: mode }), profile, {
        purpose: 'structure',
        name: 'probe',
        system: '你在帮忙测试接口。严格按要求的格式输出。',
        prompt: '列出 3 条查看 Linux 磁盘空间的命令，每条给一个简短标题。',
        schema: Probe,
        onPartial: () => {
          partials++
          firstPartialMs ??= Date.now() - t0
        },
      })
      caps.structured = {
        ok: res.output.items.length > 0,
        ms: res.ms,
        partials,
        ...(firstPartialMs !== undefined ? { firstPartialMs } : {}),
        ...(mode !== undefined ? { jsonMode: mode } : {}),
        detail: `${res.output.items.length} 条`,
      }
      break
    } catch (e) {
      caps.structured = { ok: false, ms: Date.now() - t0, detail: toLlmError(e, profile).message }
    }
  }

  // 3. 看图
  report('看图…')
  t0 = Date.now()
  try {
    const r = await generateText({
      model: bound.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片主要是什么颜色？只回答颜色。' },
            { type: 'file', data: RED_PNG, mediaType: 'image/png' },
          ],
        },
      ],
      maxOutputTokens: 64,
      providerOptions: bound.textOptions as never,
      abortSignal: AbortSignal.timeout(60_000),
      maxRetries: 0,
    })
    const answer = r.text.trim()
    caps.vision = {
      ok: /红|red/i.test(answer),
      ms: Date.now() - t0,
      detail: answer === '' ? '没有回答' : answer.slice(0, 40),
    }
  } catch (e) {
    caps.vision = { ok: false, ms: Date.now() - t0, detail: toLlmError(e, profile).message }
  }

  return caps
}

/**
 * 从端点拉模型列表，供下拉选择。
 *
 * 各家的 /models 位置不一：Anthropic 兼容端点多在 {base}/v1/models，
 * 但 DeepSeek 这类的列表挂在主域名上。依次试，都不行就返回空，
 * 界面允许手填。这是普通的 JSON 接口，不涉及模型协议。
 */
export async function listModels(input: { wire: Wire; baseUrl: string; apiKey: string }): Promise<string[]> {
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  const candidates: Array<{ url: string; headers: Record<string, string> }> = []
  const bearer = { authorization: `Bearer ${input.apiKey}` }

  if (input.wire === 'anthropic') {
    candidates.push({
      url: `${withV1(base)}/models`,
      headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' },
    })
    try {
      const origin = new URL(base).origin
      candidates.push({ url: `${origin}/models`, headers: bearer }, { url: `${origin}/v1/models`, headers: bearer })
    } catch {
      // 地址不合法，下面整体返回空
    }
  } else {
    candidates.push({ url: `${base}/models`, headers: bearer })
  }

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { headers: c.headers, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
      if (ids.length > 0) return ids.sort()
    } catch {
      // 试下一个
    }
  }
  return []
}
