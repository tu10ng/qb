/**
 * 由档案创建 AI SDK 的模型实例和调用选项。
 *
 * 各家端点的差异都收在这里：Anthropic 兼容端点强制结构化要关思考，
 * OpenAI 兼容端点可能只支持 json_object，DeepSeek 原生端点的思考开关
 * 在它自己的选项里。上层只看到一个 LanguageModel。
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { JsonMode, ModelProfile } from './profiles.ts'

/** 与 AI SDK 的 providerOptions 同形。 */
type ProviderOptions = Record<string, Record<string, unknown>>

export interface BoundModel {
  model: LanguageModel
  /** 结构化调用（Output.object）用。 */
  structuredOptions: ProviderOptions
  /** 普通文本调用（测试连接、看图）用。 */
  textOptions: ProviderOptions
  /** OpenAI 兼容端点只支持 json_object 时，schema 得自己写进提示词。 */
  injectSchema: boolean
}

/** OpenAI 兼容 provider 的名字；它的选项在 providerOptions[OPENAI_COMPAT_NAME] 下。 */
const OPENAI_COMPAT_NAME = 'qb'

export function bindModel(profile: ModelProfile, override: { jsonMode?: JsonMode } = {}): BoundModel {
  switch (profile.wire) {
    case 'anthropic': {
      const provider = createAnthropic({ baseURL: withV1(profile.baseUrl), apiKey: profile.apiKey })
      // Claude 走原生结构化输出（SDK 按模型自动选择）；兼容端点上的其他模型
      // 只能走"强制调用一个 json 工具"，而这要求关掉思考。
      const isClaude = /claude/i.test(profile.model)
      const thinking = profile.options.thinking ? {} : { thinking: { type: 'disabled' } }
      return {
        model: provider(profile.model),
        structuredOptions: {
          anthropic: { structuredOutputMode: isClaude ? 'auto' : 'jsonTool', ...thinking },
        },
        textOptions: { anthropic: { ...thinking } },
        injectSchema: false,
      }
    }

    case 'deepseek': {
      const provider = createDeepSeek({ apiKey: profile.apiKey, baseURL: trimSlash(profile.baseUrl) })
      const deepseek: Record<string, unknown> = profile.options.thinking
        ? {
            thinking: { type: 'enabled' },
            ...(profile.options.effort !== undefined ? { reasoningEffort: profile.options.effort } : {}),
          }
        : { thinking: { type: 'disabled' } }
      // 原生端点没有约束解码：provider 会用 JSON 模式并把 schema 写进系统提示
      return {
        model: provider(profile.model),
        structuredOptions: { deepseek },
        textOptions: { deepseek },
        injectSchema: false,
      }
    }

    case 'openai-compatible': {
      const jsonMode = override.jsonMode ?? profile.options.jsonMode ?? 'json_schema'
      const provider = createOpenAICompatible({
        name: OPENAI_COMPAT_NAME,
        baseURL: trimSlash(profile.baseUrl),
        apiKey: profile.apiKey,
        supportsStructuredOutputs: jsonMode === 'json_schema',
        includeUsage: true,
      })
      // strictJsonSchema 关掉：宽容 schema 里有可选字段，OpenAI 的 strict
      // 模式要求全部 required。未知键（extraBody）会原样并进请求体。
      const compat: Record<string, unknown> = { ...(profile.options.extraBody ?? {}), strictJsonSchema: false }
      return {
        model: provider(profile.model),
        structuredOptions: { [OPENAI_COMPAT_NAME]: compat },
        textOptions: { [OPENAI_COMPAT_NAME]: { ...(profile.options.extraBody ?? {}) } },
        injectSchema: jsonMode === 'json_object',
      }
    }
  }
}

/**
 * Anthropic SDK 的 baseURL 要带 /v1；用户填的通常不带
 * （DeepSeek 文档给的就是 https://api.deepseek.com/anthropic）。
 */
export function withV1(baseUrl: string): string {
  const b = trimSlash(baseUrl)
  return /\/v1$/.test(b) ? b : `${b}/v1`
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
