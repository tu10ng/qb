/**
 * Llm 端口的实现：每次调用时按用途解析档案，改了设置立即生效，不用重启。
 */

import { bindModel } from './models.ts'
import type { ModelProfile, Purpose } from './profiles.ts'
import { LlmError, type Llm, type PurposeStatus, type StructuredCall, type StructuredResult } from './port.ts'
import { runStructured } from './structured.ts'

export interface ProfileSource {
  /** 全部可用档案：环境变量的在前，本机保存的在后。 */
  profiles(): ModelProfile[]
  /** 用户为这个用途指定的档案 id。 */
  assigned(purpose: Purpose): string | null
}

export function createLlm(source: ProfileSource): Llm {
  function resolve(purpose: Purpose): ModelProfile | null {
    const all = source.profiles()
    const chosen = source.assigned(purpose)
    if (chosen !== null) {
      const p = all.find((x) => x.id === chosen)
      if (p !== undefined) return p
    }
    // 没指定时：看图优先挑测过能看图的；其余挑测过能结构化的；都没测过就用第一个
    if (purpose === 'vision') {
      const seeing = all.find((p) => p.capabilities?.vision.ok === true)
      if (seeing !== undefined) return seeing
    }
    return all.find((p) => p.capabilities?.structured.ok === true) ?? all[0] ?? null
  }

  return {
    async structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
      const profile = resolve(call.purpose)
      if (profile === null) {
        throw new LlmError(
          'not_configured',
          '还没有配置模型。到「设置 · 模型」添加一个，或者在 .env.local 里配置 QB_LLM_*。',
        )
      }
      if (call.images !== undefined && call.images.length > 0 && profile.capabilities?.vision.ok === false) {
        throw new LlmError(
          'unsupported',
          `「${profile.name}」测试时看不了图。到「设置 · 模型」给"看截图"选一个能看图的档案。`,
        )
      }
      return runStructured(bindModel(profile), profile, call)
    },

    status(purpose: Purpose): PurposeStatus {
      const p = resolve(purpose)
      if (p === null) {
        return { ok: false, profileId: null, profileName: null, reason: '还没有配置模型' }
      }
      if (purpose === 'vision' && p.capabilities?.vision.ok === false) {
        return { ok: false, profileId: p.id, profileName: p.name, reason: '当前档案测试时看不了图' }
      }
      return { ok: true, profileId: p.id, profileName: p.name, reason: null }
    },
  }
}

export { LlmError, type Llm, type StructuredCall, type StructuredResult } from './port.ts'
