/**
 * 模型档案：连哪个端点、用哪个模型、结构化调用怎么做。
 *
 * 档案存在本机（key 永不同步、不写日志），也可以来自环境变量
 * （.env.local）。预设里写的是实测过的正确组合，依据见
 * docs/adr/0002-llm-via-ai-sdk.md。
 */

import { z } from 'zod'

/** 端点说的协议。 */
export const Wire = z.enum(['anthropic', 'openai-compatible', 'deepseek'])
export type Wire = z.infer<typeof Wire>

/** 模型用在哪。不同用途可以选不同档案：整理要快，诊断可以慢一点。 */
export const Purpose = z.enum(['structure', 'diagnose', 'vision'])
export type Purpose = z.infer<typeof Purpose>

export const PURPOSE_LABEL: Record<Purpose, string> = {
  structure: '整理 / 起草',
  diagnose: '诊断',
  vision: '看截图',
}

/**
 * OpenAI 兼容端点做结构化的方式。
 *
 * json_schema：端点按 schema 约束解码（OpenAI、vLLM 都支持）。
 * json_object：端点只保证输出是 JSON，schema 得写进提示词。
 * 哪种可用由"测试连接"探明。
 */
export const JsonMode = z.enum(['json_schema', 'json_object'])
export type JsonMode = z.infer<typeof JsonMode>

export const CheckResult = z.object({
  ok: z.boolean(),
  ms: z.number().optional(),
  detail: z.string().optional(),
})
export type CheckResult = z.infer<typeof CheckResult>

export const Capabilities = z.object({
  testedAt: z.number(),
  connect: CheckResult,
  structured: CheckResult.extend({
    /** 第一个部分结果到达的时间：决定用户多久能看到第一步。 */
    firstPartialMs: z.number().optional(),
    partials: z.number().optional(),
    jsonMode: JsonMode.optional(),
  }),
  vision: CheckResult,
})
export type Capabilities = z.infer<typeof Capabilities>

export const ProfileOptions = z.object({
  /**
   * 结构化调用时让模型思考。
   *
   * 多数兼容端点在思考模式下不支持强制结构化：实测 DeepSeek 的
   * Anthropic 端点直接返回 400；开着思考也会慢 5–10 倍。
   */
  thinking: z.boolean().default(false),
  /** DeepSeek 原生端点的思考强度。 */
  effort: z.enum(['low', 'high', 'max']).optional(),
  /**
   * 输出上限。必须显式给：AI SDK 对"非 Claude 模型走 Anthropic 兼容端点"
   * 默认只给 4096，一份 runbook 加参数表就会被截断。
   */
  maxOutputTokens: z.number().int().positive().default(32_000),
  /** 单次调用超时。 */
  timeoutMs: z.number().int().positive().default(240_000),
  jsonMode: JsonMode.optional(),
  /**
   * 原样并进请求体的额外参数（仅 OpenAI 兼容端点）。
   * 例：vLLM 上的 Qwen3 关思考 {"chat_template_kwargs":{"enable_thinking":false}}
   */
  extraBody: z.record(z.string(), z.unknown()).optional(),
})
export type ProfileOptions = z.infer<typeof ProfileOptions>

export const PresetId = z.enum([
  'deepseek',
  'deepseek-native',
  'glm',
  'anthropic',
  'openai',
  'vllm',
  'custom-anthropic',
  'custom-openai',
])
export type PresetId = z.infer<typeof PresetId>

export interface ModelProfile {
  id: string
  name: string
  preset: PresetId
  wire: Wire
  baseUrl: string
  apiKey: string
  model: string
  options: ProfileOptions
  capabilities: Capabilities | null
  /** env：来自环境变量，只读，不落库。 */
  source: 'local' | 'env'
  updatedAt: number
}

export interface Preset {
  id: PresetId
  label: string
  wire: Wire
  baseUrl: string
  /** 空串表示让用户从 /models 列表里选。 */
  model: string
  note: string
  options: Partial<ProfileOptions>
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    note: 'Anthropic 兼容端点。结构化调用要关思考：开着思考时 DeepSeek 不接受强制结构化（返回 400）。',
    options: { thinking: false, maxOutputTokens: 32_000 },
  },
  {
    id: 'deepseek-native',
    label: 'DeepSeek（原生）',
    wire: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    note: '原生端点的 JSON 模式可以和思考同时开，适合要慢慢想的诊断；实测低强度思考约 30 秒。',
    options: { thinking: false, maxOutputTokens: 32_000 },
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    wire: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    note: '关思考后起草约 40 秒；开思考会到几分钟。',
    options: { thinking: false, maxOutputTokens: 32_000 },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    note: 'Claude 走原生结构化输出，可以开思考。',
    options: { maxOutputTokens: 32_000 },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    note: '',
    options: { maxOutputTokens: 16_000, jsonMode: 'json_schema' },
  },
  {
    id: 'vllm',
    label: '公司内网 vLLM',
    wire: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: '',
    note: 'OpenAI 兼容 + json_schema 约束解码。Qwen3 这类会思考的模型，可在额外参数里关掉思考。',
    options: {
      maxOutputTokens: 8192,
      jsonMode: 'json_schema',
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
  },
  {
    id: 'custom-anthropic',
    label: '自定义（Anthropic 兼容）',
    wire: 'anthropic',
    baseUrl: '',
    model: '',
    note: '',
    options: {},
  },
  {
    id: 'custom-openai',
    label: '自定义（OpenAI 兼容）',
    wire: 'openai-compatible',
    baseUrl: '',
    model: '',
    note: '',
    options: {},
  },
]

export function presetById(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!
}

/** 按地址猜预设，用于环境变量里的配置（那里只有 wire 和地址）。 */
export function guessPreset(baseUrl: string, wire: Wire): PresetId {
  if (baseUrl.includes('deepseek.com')) return wire === 'deepseek' ? 'deepseek-native' : 'deepseek'
  if (baseUrl.includes('bigmodel.cn')) return 'glm'
  if (baseUrl.includes('anthropic.com')) return 'anthropic'
  if (baseUrl.includes('openai.com')) return 'openai'
  return wire === 'anthropic' ? 'custom-anthropic' : 'custom-openai'
}

/**
 * 环境变量里的档案（`.env.local` 那套 QB_LLM_*）。
 *
 * 只读、不落库：密钥仍只在环境里。旧的 wire=openai 按 OpenAI 兼容处理。
 */
export function profileFromEnv(env: NodeJS.ProcessEnv): ModelProfile | null {
  const baseUrl = env.QB_LLM_BASE_URL?.trim()
  if (baseUrl === undefined || baseUrl === '') return null

  const rawWire = env.QB_LLM_WIRE?.trim() ?? 'anthropic'
  const wire: Wire = rawWire === 'openai' ? 'openai-compatible' : (Wire.safeParse(rawWire).data ?? 'anthropic')
  const preset = guessPreset(baseUrl, wire)
  const base = presetById(preset)

  const maxTokens = Number(env.QB_LLM_MAX_TOKENS)
  const options = ProfileOptions.parse({
    ...base.options,
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
    ...(env.QB_LLM_THINKING === '1' ? { thinking: true } : {}),
  })

  return {
    id: 'env',
    name: '环境变量（.env.local）',
    preset,
    wire,
    baseUrl,
    apiKey: env.QB_LLM_API_KEY?.trim() ?? '',
    model: env.QB_LLM_MODEL?.trim() || base.model || 'deepseek-flash',
    options,
    capabilities: null,
    source: 'env',
    updatedAt: 0,
  }
}

/** 界面上显示的 key：只露头尾，足够分辨是哪一把。 */
export function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
