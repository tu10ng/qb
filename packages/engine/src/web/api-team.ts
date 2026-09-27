/**
 * M8 路由：团队同步配置与"问发起人"的正式通道。
 *
 * 配好团队服务后，问发起人从"临时 · 复制到 IM"升级为真实发送：
 * 求助存本地（答案回流时挂回这一步）→ 事件 → 立刻推给团队服务 →
 * 发起人回答经同步回流，出现在这一步的 QB 面板里。
 */

import { z } from 'zod'
import { redact } from '@qb/core'
import type { Store } from '@qb/store'
import type { TeamSettings } from '../sync/sync.ts'
import type { Sync } from '../sync/sync.ts'
import { errMessage, sendJson, type Router } from './router.ts'

export interface TeamDeps {
  store: Store
  team: TeamSettings
  sync: Sync
  currentUserId: () => string
}

const TeamBody = z.object({
  url: z.string().trim().default(''),
  token: z.string().default(''),
  enabled: z.boolean().default(false),
})

const AskBody = z.object({
  stepId: z.string().nullable().optional(),
  body: z.string().trim().min(1, '求助内容是空的').max(8000),
})

export function registerTeamRoutes(router: Router, deps: TeamDeps): void {
  const { store, team, sync, currentUserId } = deps

  router.get('/settings/team', (_req, res) => {
    const cfg = team.get()
    // 令牌不回显全文——只回有没有（界面存的是自己那份）
    sendJson(res, 200, { ...cfg, hasToken: cfg.token !== '', token: '' })
  })

  router.post('/settings/team', (_req, res, ctx) => {
    const parsed = TeamBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    // token 留空 = 沿用已存的
    const before = team.get()
    const saved = team.save({
      url: parsed.data.url,
      token: parsed.data.token !== '' ? parsed.data.token : before.token,
      enabled: parsed.data.enabled && (parsed.data.url !== '' || before.url !== '') && (parsed.data.token !== '' || before.token !== ''),
    })
    if (saved.enabled) sync.pushNow()
    sendJson(res, 200, { ...saved, hasToken: saved.token !== '', token: '' })
  })

  router.post('/settings/team/test', async (_req, res, ctx) => {
    const parsed = TeamBody.partial().safeParse(ctx.body ?? {})
    const current = team.get()
    const cfg = {
      url: parsed.success && parsed.data.url !== undefined && parsed.data.url !== '' ? parsed.data.url : current.url,
      token: parsed.success && parsed.data.token !== undefined && parsed.data.token !== '' ? parsed.data.token : current.token,
      enabled: true,
    }
    if (cfg.url === '' || cfg.token === '') {
      sendJson(res, 400, { error: 'bad_request', message: '先填地址和令牌' })
      return
    }
    sendJson(res, 200, await sync.testConnection(cfg))
  })

  /**
   * 问发起人（正式通道）。没配团队服务时返回 sent:false，界面退回
   * "复制到 IM"的临时方案——两种路径正文一致。
   */
  router.post('/tasks/:id/ask', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = AskBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }

    const cfg = team.get()
    if (!cfg.enabled) {
      sendJson(res, 200, { sent: false, reason: 'unconfigured' })
      return
    }

    try {
      const clean = redact(parsed.data.body).text
      const { id } = store.createQuestion({
        taskId,
        stepId: parsed.data.stepId ?? null,
        askerId: currentUserId(),
        bodyMd: clean,
      })
      store.appendEvent({
        taskId,
        stepId: parsed.data.stepId ?? null,
        actorId: currentUserId(),
        kind: 'question_asked',
        payload: { questionId: id, body: clean.slice(0, 200) },
      })
      sync.pushNow()
      sendJson(res, 202, { sent: true, questionId: id })
    } catch (e) {
      sendJson(res, 400, { error: 'ask_failed', message: errMessage(e) })
    }
  })
}
