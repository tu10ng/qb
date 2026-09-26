/**
 * 设置 · 模型：档案的增删改、按用途选择、测试连接、拉模型列表。
 *
 * key 只进不出：接口返回的档案只带打码后的 keyHint；编辑时不传 key
 * 表示沿用原来的。
 */

import { z } from 'zod'
import { testProfile, listModels } from '../llm/capabilities.ts'
import type { Llm } from '../llm/port.ts'
import { PRESETS, PresetId, ProfileOptions, Purpose, Wire } from '../llm/profiles.ts'
import type { LlmSettings } from '../settings/llm-settings.ts'
import type { Jobs } from './jobs.ts'
import { errMessage, sendJson, type Router } from './router.ts'

export interface SettingsDeps {
  settings: LlmSettings
  llm: Llm
  jobs: Jobs
}

const ProfileBody = z.object({
  id: z.string().optional(),
  name: z.string().default(''),
  preset: PresetId,
  wire: Wire,
  baseUrl: z.string().trim().url('地址不是合法的 URL'),
  model: z.string().trim().min(1, '模型名不能为空'),
  apiKey: z.string().optional(),
  options: ProfileOptions.partial().optional(),
})

// partialRecord：一次只改一个用途。zod 4 的 record 配枚举键是"每个键都必填"
const PurposesBody = z.partialRecord(Purpose, z.string().nullable())

/**
 * 拉模型列表：可以指向已存档案（沿用它的 key），也可以带上表单里正在
 * 填的地址与 key；两者都给时表单里的优先（key 为空则沿用档案的）。
 */
const ModelsBody = z.object({
  profileId: z.string().optional(),
  wire: Wire.optional(),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
})

export function registerSettingsRoutes(router: Router, deps: SettingsDeps): void {
  const { settings, llm, jobs } = deps

  const snapshot = () => ({
    profiles: settings.profiles().map((p) => settings.toPublic(p)),
    purposes: settings.purposes(),
    status: {
      structure: llm.status('structure'),
      diagnose: llm.status('diagnose'),
      vision: llm.status('vision'),
    },
    presets: PRESETS,
  })

  router.get('/settings/llm', (_req, res) => {
    sendJson(res, 200, snapshot())
  })

  router.post('/settings/llm/profiles', (_req, res, ctx) => {
    const parsed = ProfileBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    try {
      const { options, ...rest } = parsed.data
      const saved = settings.save({ ...rest, ...(options !== undefined ? { options } : {}) })
      // 第一个档案自动成为所有用途的默认，省得用户再去选一次
      if (settings.profiles().filter((p) => p.source === 'local').length === 1 && Object.keys(settings.purposes()).length === 0) {
        settings.setPurposes({ structure: saved.id, diagnose: saved.id, vision: saved.id })
      }
      sendJson(res, 201, { profile: settings.toPublic(saved), ...snapshot() })
    } catch (e) {
      sendJson(res, 400, { error: 'save_failed', message: errMessage(e) })
    }
  })

  router.delete('/settings/llm/profiles/:id', (_req, res, ctx) => {
    try {
      settings.delete(ctx.params.id!)
      sendJson(res, 200, snapshot())
    } catch (e) {
      sendJson(res, 400, { error: 'delete_failed', message: errMessage(e) })
    }
  })

  router.post('/settings/llm/purposes', (_req, res, ctx) => {
    const parsed = PurposesBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: '用途或档案 id 不合法' })
      return
    }
    for (const id of Object.values(parsed.data)) {
      if (id !== null && settings.get(id) === null) {
        sendJson(res, 400, { error: 'bad_request', message: `档案 ${id} 不存在` })
        return
      }
    }
    settings.setPurposes(parsed.data)
    sendJson(res, 200, snapshot())
  })

  /** 测试连接：依次探明能力，进度经 job.update 推送，结果写回档案。 */
  router.post('/settings/llm/profiles/:id/test', (_req, res, ctx) => {
    const profile = settings.get(ctx.params.id!)
    if (profile === null) {
      sendJson(res, 404, { error: 'not_found', message: '档案不存在' })
      return
    }
    const { job, existing } = jobs.start('llm-test', profile.id, async (report) => {
      const caps = await testProfile(profile, report)
      settings.saveCapabilities(profile.id, caps)
      return caps
    })
    sendJson(res, existing ? 200 : 202, { jobId: job.id, existing })
  })

  router.post('/settings/llm/models', async (_req, res, ctx) => {
    const parsed = ModelsBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: '参数不合法' })
      return
    }
    const b = parsed.data
    const base = b.profileId !== undefined ? settings.get(b.profileId) : null
    const wire = b.wire ?? base?.wire
    const baseUrl = b.baseUrl !== undefined && b.baseUrl !== '' ? b.baseUrl : base?.baseUrl
    // 存着的 key 只发往它原本所属的站点：换了地址就要重新填，
    // 免得一次请求把 key 送到别处
    const sameSite = base !== null && baseUrl !== undefined && originOf(baseUrl) === originOf(base.baseUrl)
    const apiKey = b.apiKey !== undefined && b.apiKey !== '' ? b.apiKey : sameSite ? base.apiKey : ''
    if (wire === undefined || baseUrl === undefined) {
      sendJson(res, 400, { error: 'bad_request', message: '需要地址和协议' })
      return
    }
    sendJson(res, 200, { models: await listModels({ wire, baseUrl, apiKey }) })
  })
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
