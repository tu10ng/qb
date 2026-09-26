import { describe, expect, it } from 'vitest'
import { openDb, Store } from '@qb/server'
import { LlmSettings } from '../src/settings/llm-settings.ts'
import { Capabilities, type PresetId, type Wire } from '../src/llm/profiles.ts'

/**
 * 模型设置的持久化行为。重点：测试连接探明的 json_object 要写进
 * 档案 options——否则只支持 json_object 的端点（部分 vLLM 服务）每次
 * 结构化调用仍按 json_schema 发，全都会失败。
 */

function newSettings(env: NodeJS.ProcessEnv = {}): { settings: LlmSettings; store: Store } {
  const store = new Store(openDb({ path: ':memory:' }))
  return { settings: new LlmSettings(store, env), store }
}

function saveProfile(settings: LlmSettings, wire: Wire = 'openai-compatible', preset: PresetId = 'vllm') {
  return settings.save({
    name: '内网 vLLM',
    preset,
    wire,
    baseUrl: 'http://10.0.0.8:8000/v1',
    apiKey: 'sk-local-test',
    model: 'Qwen3-32B',
    // jsonMode 只对 OpenAI 兼容端点有意义；anthropic 端点不预设
    options: wire === 'openai-compatible' ? { jsonMode: 'json_schema' as const } : {},
  })
}

function capsOk(jsonMode: 'json_schema' | 'json_object') {
  return Capabilities.parse({
    testedAt: 1,
    connect: { ok: true },
    structured: { ok: true, jsonMode },
    vision: { ok: false, detail: 'x' },
  })
}

describe('LlmSettings', () => {
  it('测试连接探明 json_object 后写回 options', () => {
    const { settings } = newSettings()
    const p = saveProfile(settings)
    expect(p.options.jsonMode).toBe('json_schema')

    settings.saveCapabilities(p.id, capsOk('json_object'))
    expect(settings.get(p.id)!.options.jsonMode).toBe('json_object')
  })

  it('结构化测试没通过时不改 options', () => {
    const { settings } = newSettings()
    const p = saveProfile(settings)
    const failed = Capabilities.parse({ testedAt: 1, connect: { ok: true }, structured: { ok: false }, vision: { ok: false } })
    settings.saveCapabilities(p.id, failed)
    expect(settings.get(p.id)!.options.jsonMode).toBe('json_schema')
  })

  it('非 OpenAI 兼容端点不写 jsonMode', () => {
    const { settings } = newSettings()
    const p = saveProfile(settings, 'anthropic', 'custom-anthropic')
    settings.saveCapabilities(p.id, capsOk('json_object'))
    expect(settings.get(p.id)!.options.jsonMode).toBeUndefined()
  })

  it('环境变量档案：save() 拒绝，capabilities 按指纹缓存', () => {
    const { settings } = newSettings({
      QB_LLM_WIRE: 'anthropic',
      QB_LLM_BASE_URL: 'https://api.deepseek.com/anthropic',
      QB_LLM_API_KEY: 'sk-env-test',
      QB_LLM_MODEL: 'deepseek-flash',
    })
    const env = settings.get('env')!
    expect(env.model).toBe('deepseek-flash')

    expect(() => settings.save({ ...env, id: 'env', apiKey: '' })).toThrow(/只读/)
    settings.saveCapabilities('env', capsOk('json_object'))
    // 重新读（缓存生效）
    expect(settings.get('env')!.capabilities?.structured.jsonMode).toBe('json_object')

    // 换了模型：指纹变了，旧能力作废
    const changed = newSettings({
      QB_LLM_WIRE: 'anthropic',
      QB_LLM_BASE_URL: 'https://api.deepseek.com/anthropic',
      QB_LLM_API_KEY: 'sk-env-test',
      QB_LLM_MODEL: 'deepseek-v4-pro',
    })
    expect(changed.settings.get('env')!.capabilities).toBeNull()
  })

  it('删除档案时解除指向它的用途', () => {
    const { settings } = newSettings()
    const p = saveProfile(settings)
    settings.setPurposes({ structure: p.id, diagnose: p.id })
    settings.delete(p.id)
    expect(settings.purposes()).toEqual({})
  })
})
