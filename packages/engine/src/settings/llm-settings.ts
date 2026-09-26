/**
 * 模型设置：本机保存的档案 + 环境变量里的档案 + 按用途的选择。
 *
 * key 只存在本机这份库里。对外（HTTP 接口、日志）一律只给打码后的样子。
 */

import type { Store, StoredModelProfile } from '@qb/server'
import {
  Capabilities,
  ProfileOptions,
  PresetId,
  Purpose,
  Wire,
  maskKey,
  presetById,
  profileFromEnv,
  type ModelProfile,
} from '../llm/profiles.ts'
import type { ProfileSource } from '../llm/index.ts'

const PURPOSES_KEY = 'llm.purposes'
/** 环境变量档案不落库，它的测试结果按"指纹"单独存：换了地址或模型就作废。 */
const ENV_CAPS_KEY = 'llm.env.capabilities'

export interface PublicProfile {
  id: string
  name: string
  preset: PresetId
  wire: Wire
  baseUrl: string
  model: string
  /** 打码后的 key；空串表示没填。 */
  keyHint: string
  options: ProfileOptions
  capabilities: Capabilities | null
  source: 'local' | 'env'
  updatedAt: number
}

export interface ProfileInput {
  id?: string
  name: string
  preset: PresetId
  wire: Wire
  baseUrl: string
  model: string
  /** 不传表示保留原来的 key（编辑时不必重新输入）。 */
  apiKey?: string
  options?: Partial<ProfileOptions>
}

export class LlmSettings implements ProfileSource {
  private readonly store: Store
  private readonly env: NodeJS.ProcessEnv

  constructor(store: Store, env: NodeJS.ProcessEnv) {
    this.store = store
    this.env = env
  }

  profiles(): ModelProfile[] {
    const out: ModelProfile[] = []
    const fromEnv = profileFromEnv(this.env)
    if (fromEnv !== null) out.push({ ...fromEnv, capabilities: this.envCapabilities(fromEnv) })
    for (const row of this.store.listModelProfiles()) {
      const p = fromRow(row)
      if (p !== null) out.push(p)
    }
    return out
  }

  get(id: string): ModelProfile | null {
    return this.profiles().find((p) => p.id === id) ?? null
  }

  assigned(purpose: Purpose): string | null {
    const map = this.store.getSetting<Partial<Record<Purpose, string>>>(PURPOSES_KEY) ?? {}
    return map[purpose] ?? null
  }

  purposes(): Partial<Record<Purpose, string>> {
    return this.store.getSetting<Partial<Record<Purpose, string>>>(PURPOSES_KEY) ?? {}
  }

  setPurposes(next: Partial<Record<Purpose, string | null>>): void {
    const map = { ...this.purposes() }
    for (const [purpose, id] of Object.entries(next) as Array<[Purpose, string | null]>) {
      if (id === null) delete map[purpose]
      else map[purpose] = id
    }
    this.store.setSetting(PURPOSES_KEY, map)
  }

  save(input: ProfileInput): ModelProfile {
    if (input.id === 'env') throw new Error('环境变量里的档案是只读的；要改请改 .env.local')

    const existing = input.id !== undefined ? this.store.getModelProfile(input.id) : null
    const preset = presetById(input.preset)
    const options = ProfileOptions.parse({ ...preset.options, ...(existing?.options ?? {}), ...(input.options ?? {}) })

    // 换了地址、模型、协议或思考开关，旧的测试结果就不作数了
    const sameTarget =
      existing !== null &&
      existing.baseUrl === input.baseUrl &&
      existing.model === input.model &&
      existing.wire === input.wire &&
      JSON.stringify(existing.options) === JSON.stringify(options)

    const row = this.store.saveModelProfile({
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name.trim() === '' ? `${preset.label} · ${input.model}` : input.name.trim(),
      preset: input.preset,
      wire: input.wire,
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey !== undefined ? input.apiKey.trim() : (existing?.apiKey ?? ''),
      model: input.model.trim(),
      options,
      capabilities: sameTarget ? existing.capabilities : null,
    })
    return fromRow(row)!
  }

  delete(id: string): void {
    if (id === 'env') throw new Error('环境变量里的档案是只读的')
    this.store.deleteModelProfile(id)
    // 指向它的用途一并解除，否则会指向一个不存在的档案
    const map = this.purposes()
    for (const purpose of Object.keys(map) as Purpose[]) {
      if (map[purpose] === id) delete map[purpose]
    }
    this.store.setSetting(PURPOSES_KEY, map)
  }

  saveCapabilities(id: string, caps: Capabilities): void {
    if (id === 'env') {
      const env = profileFromEnv(this.env)
      if (env !== null) this.store.setSetting(ENV_CAPS_KEY, { fingerprint: fingerprint(env), caps })
      return
    }
    const row = this.store.getModelProfile(id)
    if (row === null) return
    // 探明的结构化方式写进 options，之后的调用直接照用（json_object 端点
    // 若继续按 json_schema 请求会每次失败）
    const options =
      caps.structured.ok && caps.structured.jsonMode !== undefined && row.wire === 'openai-compatible'
        ? { ...row.options, jsonMode: caps.structured.jsonMode }
        : row.options
    this.store.saveModelProfile({ ...row, options, capabilities: caps })
  }

  toPublic(p: ModelProfile): PublicProfile {
    return {
      id: p.id,
      name: p.name,
      preset: p.preset,
      wire: p.wire,
      baseUrl: p.baseUrl,
      model: p.model,
      keyHint: maskKey(p.apiKey),
      options: p.options,
      capabilities: p.capabilities,
      source: p.source,
      updatedAt: p.updatedAt,
    }
  }

  private envCapabilities(env: ModelProfile): Capabilities | null {
    const saved = this.store.getSetting<{ fingerprint: string; caps: unknown }>(ENV_CAPS_KEY)
    if (saved === null || saved.fingerprint !== fingerprint(env)) return null
    return Capabilities.safeParse(saved.caps).data ?? null
  }
}

/** 不含 key：指纹会落库。 */
function fingerprint(p: ModelProfile): string {
  return [p.wire, p.baseUrl, p.model, JSON.stringify(p.options)].join('|')
}

/** 库里的行 → 档案。字段不合法的行跳过，不让一条坏数据拖垮整个设置页。 */
function fromRow(row: StoredModelProfile): ModelProfile | null {
  const preset = PresetId.safeParse(row.preset)
  const wire = Wire.safeParse(row.wire)
  const options = ProfileOptions.safeParse(row.options)
  if (!preset.success || !wire.success || !options.success) return null
  return {
    id: row.id,
    name: row.name,
    preset: preset.data,
    wire: wire.data,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: row.model,
    options: options.data,
    capabilities: row.capabilities === null ? null : (Capabilities.safeParse(row.capabilities).data ?? null),
    source: 'local',
    updatedAt: row.updatedAt,
  }
}
