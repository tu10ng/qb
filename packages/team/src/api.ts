/**
 * 团队服务的 HTTP API（Hono）。
 *
 * 三类调用者：
 * - 浏览器（远程模式 UI）：join/login、看镜像、评论、回答、已读、推送渠道
 * - 执行引擎：POST /api/sync/push（镜像 + 告警 + 下行回流）
 * - 启动器/运维：健康检查
 *
 * 认证：Authorization: Bearer <个人令牌>。引擎与浏览器同一种令牌。
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { pushAlert, testChannel, type QuietHours } from './push.ts'
import type { SyncPush, TeamStore } from './store.ts'

export interface ApiOptions {
  store: TeamStore
  /** 告警落库后要通知的钩子（WS 广播给远程 UI）。 */
  onIngest?: (taskIds: string[]) => void
  onComment?: (taskId: string) => void
  onAnswer?: (taskId: string) => void
  onAck?: (taskId: string) => void
}

export type AppEnv = { Variables: { user: { id: string; name: string; displayName: string; isAdmin: boolean } } }

export function createApp(opts: ApiOptions): Hono<AppEnv> {
  const { store } = opts
  const app = new Hono<AppEnv>()

  // 引擎同步回路的报错要能看见（否则只有干巴巴的 500，没法排查）
  app.onError((err, c) => {
    // 细节只进服务端日志；给客户端的文案固定，SQLite 报错不该泄 schema
    console.error('[qb-team] 处理出错:', err instanceof Error ? err.stack ?? err.message : err)
    return c.json({ error: 'internal', message: '服务内部错误，看团队服务日志' }, 500)
  })

  // ── 认证 ───────────────────────────────────────────────

  app.use('/api/*', async (c, next) => {
    // join 和 sync 之外都要令牌；sync 也是令牌（引擎的）
    if (c.req.path === '/api/join' || c.req.path === '/api/health') return next()
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (token === '') return c.json({ error: 'unauthorized', message: '缺少令牌' }, 401)
    const user = store.userByToken(token)
    if (user === null) return c.json({ error: 'unauthorized', message: '令牌无效' }, 401)
    c.set('user', user)
    return next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, service: 'qb-team' }))

  app.post('/api/join', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z
      .object({ invite: z.string().min(1), name: z.string().trim().min(1, '要起个名字').max(40) })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') }, 400)

    try {
      store.consumeInvite(parsed.data.invite)
    } catch (e) {
      return c.json({ error: 'bad_invite', message: e instanceof Error ? e.message : String(e) }, 400)
    }
    if (store.userByName(parsed.data.name) !== null) {
      return c.json({ error: 'bad_request', message: '这个名字已经被用了' }, 400)
    }
    const user = store.createUser(parsed.data.name)
    const token = store.issueToken(user.id)
    return c.json({ user, token }, 201)
  })

  app.get('/api/me', (c) => c.json(c.get('user')))

  // 引擎也可以用同一接口换令牌有效性
  app.post('/api/tokens', (c) => {
    const token = store.issueToken(c.get('user').id)
    return c.json({ token }, 201)
  })

  // ── 引擎同步 ──────────────────────────────────────────

  const SyncBody = z.object({
    user: z.object({ name: z.string(), displayName: z.string() }),
    sinceDownSeq: z.number().int().nonnegative(),
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        briefMd: z.string().default(''),
        initiatorName: z.string().default(''),
        assigneeName: z.string().default(''),
        status: z.string(),
        parentStepId: z.string().nullable().optional(),
        expectedMinutes: z.number().int().positive().nullable(),
        startedAt: z.number().int().nullable(),
        endedAt: z.number().int().nullable(),
        runbookVersion: z.number().int().positive().nullable(),
        steps: z
          .array(
            z.object({
              taskId: z.string(),
              id: z.string(),
              parentId: z.string().nullable(),
              orderKey: z.string(),
              kind: z.string(),
              title: z.string(),
              command: z.string().nullable(),
              status: z.string(),
              expectedMinutes: z.number().nullable(),
              actualMs: z.number().int().nullable(),
              statusNote: z.string().nullable(),
            }),
          )
          .optional(),
      }),
    ),
    events: z.array(
      z.object({
        taskId: z.string(),
        engineSeq: z.number().int(),
        stepId: z.string().nullable(),
        actorName: z.string().nullable(),
        kind: z.string(),
        payload: z.record(z.string(), z.unknown()).default({}),
        createdAt: z.number().int(),
      }),
    ),
    alerts: z.array(
      z.object({
        key: z.string(),
        taskId: z.string(),
        stepId: z.string().nullable(),
        level: z.enum(['red', 'yellow']),
        type: z.string(),
        message: z.string(),
        at: z.number().int(),
      }),
    ),
    questions: z.array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        stepId: z.string().nullable(),
        body: z.string(),
        createdAt: z.number().int(),
      }),
    ),
  })

  app.post('/api/sync/push', async (c) => {
    const parsed = SyncBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') }, 400)

    // 单写者落地：只能以自己的身份推数据。否则任何个人令牌都能伪造
    // 别人的任务/事件/告警。
    if (parsed.data.user.name !== c.get('user').name) {
      return c.json({ error: 'forbidden', message: `推送身份（${parsed.data.user.name}）与令牌持有者（${c.get('user').name}）不一致` }, 403)
    }

    const result = store.ingestPush(parsed.data as SyncPush)

    // 新红告警 → 推渠道（异步，别卡住同步回路；结果进日志便于排查）
    for (const alert of result.newRedAlerts) {
      const task = store.taskById(alert.taskId)
      if (task === null) continue
      const steps = store.stepsOf(alert.taskId)
      const stepTitle = alert.stepId !== null ? (steps.find((s) => s.id === alert.stepId)?.title ?? null) : null
      void pushAlert(store, { alert, task, stepTitle }).then((outcomes) => {
        for (const o of outcomes) {
          if (!o.ok) console.warn(`[qb-team] 推送失败（${o.channelName}）：${o.detail}`)
        }
      })
    }

    const changedTasks = new Set<string>([...parsed.data.tasks.map((t) => t.id), ...result.newRedAlerts.map((a) => a.taskId), ...result.resolvedAlerts.map((a) => a.taskId)])
    opts.onIngest?.([...changedTasks])
    return c.json(result)
  })

  // ── 远程 UI（发起人视角）───────────────────────────────

  app.get('/api/overview', (c) => {
    const me = c.get('user').name
    return c.json({
      initiated: store.listTasks('related', me),
      assigned: store.listTasks('assigned', me),
      openAlerts: store.openAlertsForUser(me),
    })
  })

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id')
    const task = store.taskById(id)
    if (task === null) return c.json({ error: 'not_found' }, 404)
    return c.json({
      task,
      steps: store.stepsOf(id),
      events: store.eventsOf(id),
      comments: store.commentsOf(id),
      questions: store.questionsOf(id),
      alerts: store.alertsOf(id),
    })
  })

  app.post('/api/tasks/:id/comments', async (c) => {
    const id = c.req.param('id')
    if (store.taskById(id) === null) return c.json({ error: 'not_found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ stepId: z.string().nullable().optional(), body: z.string().trim().min(1, '评论不能为空').max(4000) }).safeParse(body)
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') }, 400)
    const comment = store.addComment(id, c.get('user'), parsed.data.body, parsed.data.stepId ?? null)
    opts.onComment?.(id)
    return c.json(comment, 201)
  })

  app.post('/api/questions/:id/answer', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ answer: z.string().trim().min(1, '回答不能为空').max(4000) }).safeParse(body)
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') }, 400)
    try {
      const q = store.answerQuestion(id, parsed.data.answer, c.get('user'))
      opts.onAnswer?.(q.taskId)
      return c.json(q)
    } catch (e) {
      return c.json({ error: 'not_found', message: e instanceof Error ? e.message : String(e) }, 404)
    }
  })

  app.post('/api/alerts/:key/ack', (c) => {
    const key = c.req.param('key')
    try {
      const alert = store.ackAlert(key, c.get('user'))
      opts.onAck?.(alert.taskId)
      return c.json(alert)
    } catch (e) {
      return c.json({ error: 'not_found', message: e instanceof Error ? e.message : String(e) }, 404)
    }
  })

  // ── 推送渠道与设置（管理）───────────────────────────────

  const ChannelBody = z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1),
    kind: z.enum(['webhook', 'command']),
    config: z.record(z.string(), z.unknown()),
    minLevel: z.enum(['red', 'yellow']).default('red'),
    enabled: z.boolean().default(true),
  })

  const requireAdmin = (c: { get(k: 'user'): { isAdmin: boolean } }): boolean => c.get('user').isAdmin

  app.get('/api/push/channels', (c) => c.json({ channels: store.listChannels() }))

  // ── 远程派任务（PL → 执行者）─────────────────────────────
  app.get('/api/users', (c) => c.json({ users: store.listUsers() }))

  app.post('/api/dispatch', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z
      .object({
        title: z.string().trim().min(1, '标题不能为空').max(200),
        briefMd: z.string().max(20_000).default(''),
        assigneeName: z.string().trim().min(1, '要选执行者'),
        parentStepId: z.string().nullable().optional(),
        expectedMinutes: z.number().int().positive().nullable().optional(),
        definitionOfDone: z.string().max(2000).nullable().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') }, 400)

    const assignee = store.userByName(parsed.data.assigneeName)
    if (assignee === null) return c.json({ error: 'bad_request', message: `执行者「${parsed.data.assigneeName}」还没注册过` }, 400)
    if (assignee.name === c.get('user').name) {
      return c.json({ error: 'bad_request', message: '派给自己就不用派了——直接在执行端建任务即可' }, 400)
    }

    const r = store.dispatchTask({
      title: parsed.data.title,
      briefMd: parsed.data.briefMd,
      initiator: c.get('user'),
      assigneeName: assignee.name,
      parentStepId: parsed.data.parentStepId ?? null,
      expectedMinutes: parsed.data.expectedMinutes ?? null,
      definitionOfDone: parsed.data.definitionOfDone ?? null,
    })
    return c.json({ taskId: r.id }, 201)
  })

  // 管理员续发邀请（首张邀请用尽后新人从这进来）
  app.post('/api/invites', (c) => {
    if (!requireAdmin(c)) return c.json({ error: 'forbidden', message: '只有管理员能发邀请' }, 403)
    const token = store.createInvite(24 * 60 * 60_000, 3, c.get('user').id)
    return c.json({ invite: token, url: `/#/join/${token}` }, 201)
  })

  app.post('/api/push/channels', async (c) => {
    const parsed = ChannelBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') }, 400)
    if (!requireAdmin(c)) return c.json({ error: 'forbidden', message: '只有管理员能配推送渠道（命令渠道会以服务进程执行命令）' }, 403)
    if (parsed.data.kind === 'webhook' && typeof parsed.data.config.url !== 'string') {
      return c.json({ error: 'bad_request', message: 'webhook 渠道要填 url' }, 400)
    }
    if (parsed.data.kind === 'webhook' && !/^https?:\/\//.test(String(parsed.data.config.url))) {
      return c.json({ error: 'bad_request', message: 'url 要以 http:// 或 https:// 开头' }, 400)
    }
    if (parsed.data.kind === 'command' && typeof parsed.data.config.command !== 'string') {
      return c.json({ error: 'bad_request', message: 'command 渠道要填 command（如 python push.py）' }, 400)
    }
    return c.json({ channel: store.saveChannel(parsed.data) }, 201)
  })

  app.delete('/api/push/channels/:id', (c) => {
    if (!requireAdmin(c)) return c.json({ error: 'forbidden', message: '只有管理员能删推送渠道' }, 403)
    store.deleteChannel(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/push/test', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ch = store.listChannels().find((x) => x.id === (body as { id?: string }).id)
    if (ch === undefined) return c.json({ error: 'not_found', message: '渠道不存在（先保存）' }, 404)
    return c.json(await testChannel(ch))
  })

  app.get('/api/settings', (c) => c.json({ quietHours: store.getSetting<QuietHours>('quietHours') }))

  app.post('/api/settings/quiet-hours', async (c) => {
    const parsed = z
      .object({ enabled: z.boolean(), start: z.string().regex(/^\d{1,2}:\d{2}$/), end: z.string().regex(/^\d{1,2}:\d{2}$/) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'bad_request', message: '格式：{enabled, start:"22:00", end:"08:00"}' }, 400)
    store.setSetting('quietHours', parsed.data)
    return c.json(parsed.data)
  })

  return app
}
