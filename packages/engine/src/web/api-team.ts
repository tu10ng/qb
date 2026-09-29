/**
 * M8 路由：团队同步配置与"问发起人"的正式通道；委派；告警静音。
 *
 * 配好团队服务后，问发起人从"临时 · 复制到 IM"升级为真实发送：
 * 求助存本地（答案回流时挂回这一步）→ 事件 → 立刻推给团队服务 →
 * 发起人回答经同步回流，出现在这一步的 QB 面板里。
 *
 * 委派（delegate）：把这步变成对方的任务，经团队服务的 dispatch 通道
 * 派出去；对方引擎几秒内收到，进度按父步骤回流到委派行上。委派方本机
 * 不建子任务副本——那份副本会被当成另一个任务推上去，成了团队里的
 * 幽灵任务，且它的 id 和对方的对不上，进度永远回不来。
 */

import { z } from 'zod'
import { redact, redactSecrets } from '@qb/core'
import type { Store } from '@qb/store'
import type { TeamConfig, TeamSettings } from '../sync/sync.ts'
import type { Sync } from '../sync/sync.ts'
import { errMessage, sendJson, type Router } from './router.ts'
import type { createWsHandler } from './ws.ts'

export interface TeamDeps {
  store: Store
  team: TeamSettings
  sync: Sync
  ws: ReturnType<typeof createWsHandler>
  currentUserId: () => string
  userName: () => string
}

const TeamBody = z.object({
  url: z.string().trim().default(''),
  token: z.string().default(''),
  enabled: z.boolean().default(false),
})

const AskBody = z.object({
  stepId: z.string().nullable().optional(),
  body: z.string().trim().min(1, '求助内容是空的').max(8000),
  /** 问的是某条还没答案的问答：回答回来就填进它的"答"。 */
  lessonId: z.string().nullable().optional(),
})

const DelegateBody = z.object({
  assigneeName: z.string().trim().min(1, '要选委派给谁'),
  /** 界面选人时带上的显示名，委派行标题用。 */
  displayName: z.string().trim().max(40).optional(),
  /** 交代一句（进对方任务的说明）。 */
  note: z.string().trim().max(2000).optional(),
})

const SnoozeBody = z.object({
  key: z.string().min(1, '要给告警 key'),
  minutes: z.number().int().positive().max(120).default(30),
})

const teamUrl = (cfg: TeamConfig, path: string): string => `${cfg.url.replace(/\/+$/, '')}${path}`

export function registerTeamRoutes(router: Router, deps: TeamDeps): void {
  const { store, team, sync, ws, currentUserId } = deps

  const publicCfg = (cfg: TeamConfig) => ({
    url: cfg.url,
    enabled: cfg.enabled,
    hasToken: cfg.token !== '',
    token: '',
    identity: cfg.identity ?? null,
    status: sync.status(),
  })

  router.get('/settings/team', (_req, res) => {
    // 令牌不回显全文——只回有没有（界面存的是自己那份）
    sendJson(res, 200, publicCfg(team.get()))
  })

  router.post('/settings/team', async (_req, res, ctx) => {
    const parsed = TeamBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    // token 留空 = 沿用已存的
    const before = team.get()
    const url = parsed.data.url !== '' ? parsed.data.url : before.url
    const token = parsed.data.token !== '' ? parsed.data.token : before.token
    const enabled = parsed.data.enabled && url !== '' && token !== ''
    // 地址或令牌换了，身份就得重新认：推送一律用令牌对应的团队身份
    const sameCredentials = url === before.url && token === before.token
    let identity = sameCredentials ? (before.identity ?? null) : null
    let detail: string | null = null
    if (enabled && identity === null) {
      const r = await sync.fetchIdentity({ url, token })
      if (r.ok && r.identity !== undefined) identity = r.identity
      else detail = r.detail
    }
    const saved = team.save({ url, token, enabled, identity })
    if (saved.enabled) sync.pushNow()
    sendJson(res, 200, { ...publicCfg(saved), ...(detail !== null ? { warning: `还没认出团队身份：${detail}` } : {}) })
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
    const r = await sync.testConnection(cfg)
    // 测的就是已保存的那套：顺手把身份记下
    if (r.ok && r.identity !== undefined && cfg.url === current.url && cfg.token === current.token) {
      team.save({ ...current, identity: r.identity })
    }
    sendJson(res, 200, r)
  })

  /** 团队里的人（派任务、委派、填发起人时选人用）。没配团队时是空表。 */
  router.get('/team/users', async (_req, res) => {
    const cfg = team.get()
    if (!cfg.enabled) {
      sendJson(res, 200, { users: [], enabled: false })
      return
    }
    try {
      const r = await fetch(teamUrl(cfg, '/api/users'), { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`团队服务返回 HTTP ${r.status}`)
      const body = (await r.json()) as { users: Array<{ name: string; displayName: string; taskCount?: number }> }
      sendJson(res, 200, {
        enabled: true,
        me: cfg.identity?.name ?? null,
        users: body.users.map((u) => ({ name: u.name, displayName: u.displayName, taskCount: u.taskCount ?? 0 })),
      })
    } catch (e) {
      sendJson(res, 502, { error: 'team_unreachable', message: errMessage(e), users: [] })
    }
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
      const clean = redactSecrets(redact(parsed.data.body).text, store.getLatestRunbook(taskId)?.runbook.params ?? []).text
      const lessonId = parsed.data.lessonId != null && store.lessonById(parsed.data.lessonId) !== null ? parsed.data.lessonId : null
      const { id } = store.createQuestion({
        taskId,
        stepId: parsed.data.stepId ?? null,
        askerId: currentUserId(),
        bodyMd: clean,
        lessonId,
      })
      store.appendEvent({
        taskId,
        stepId: parsed.data.stepId ?? null,
        actorId: currentUserId(),
        kind: 'question_asked',
        payload: { questionId: id, body: clean.slice(0, 200), ...(lessonId !== null ? { lessonId } : {}) },
      })
      ws.broadcast({ type: 'runbook.changed', taskId, stepId: parsed.data.stepId ?? null })
      sync.pushNow()
      sendJson(res, 202, { sent: true, questionId: id })
    } catch (e) {
      sendJson(res, 400, { error: 'ask_failed', message: errMessage(e) })
    }
  })

  /**
   * 委派这步给别人：经团队服务派一个任务给对方（对方引擎几秒内收到），
   * 这一步变成委派行，记下对方任务在团队上的 id。对方的进度按父步骤回流
   * （sync.ts 的 task_progress），对方完成时这一步自动完成。
   */
  router.post('/steps/:id/delegate', async (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    const taskId = store.taskIdOfStep(stepId)
    if (step === null || taskId === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    const parsed = DelegateBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const cfg = team.get()
    if (!cfg.enabled) {
      sendJson(res, 400, { error: 'team_not_configured', message: '委派需要团队服务。到「设置 · 团队」配置后再试。' })
      return
    }
    if (store.delegationOf(stepId) !== null) {
      sendJson(res, 409, { error: 'already_delegated', message: '这一步已经委派出去了' })
      return
    }
    if (step.status === 'running') {
      sendJson(res, 409, { error: 'running', message: '这一步正在执行，先取消再委派' })
      return
    }

    const task = store.getTask(taskId)!
    const title = step.title.replace(/^→ [^:]+:\s*/, '')
    const brief = [
      `（由委派产生——原任务「${task.title}」的步骤「${title}」）`,
      parsed.data.note !== undefined && parsed.data.note !== '' ? `交代：${parsed.data.note}` : '',
      step.whyMd !== null ? `目的：${step.whyMd}` : '',
      step.command !== null ? `参考命令：\n\`\`\`\n${step.command}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    let teamTaskId: string
    try {
      const r = await fetch(teamUrl(cfg, '/api/dispatch'), {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          briefMd: redact(brief).text,
          assigneeName: parsed.data.assigneeName,
          parentStepId: stepId,
          ...(step.expectedMinutes !== null ? { expectedMinutes: Math.max(1, Math.ceil(step.expectedMinutes)) } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await r.json().catch(() => null)) as { taskId?: string; message?: string } | null
      if (!r.ok || typeof body?.taskId !== 'string') {
        throw new Error(`团队服务返回 HTTP ${r.status}${typeof body?.message === 'string' ? `：${body.message}` : ''}`)
      }
      teamTaskId = body.taskId
    } catch (e) {
      sendJson(res, 502, { error: 'dispatch_failed', message: `委派没派出去（这一步没动）：${errMessage(e)}` })
      return
    }

    const who = parsed.data.displayName !== undefined && parsed.data.displayName !== '' ? parsed.data.displayName : parsed.data.assigneeName
    store.inTransaction(() => {
      store.createDelegation({ stepId, teamTaskId, assigneeName: parsed.data.assigneeName })
      store.updateStep(stepId, { kind: 'delegate', title: `→ ${who}: ${title}` }, { expectedRev: step.rev, actorId: currentUserId() })
      store.updateStepStatus(stepId, 'running', { startedAt: Date.now() })
      store.markTaskStarted(taskId, currentUserId())
      store.appendEvent({
        taskId,
        stepId,
        actorId: currentUserId(),
        kind: 'delegate_progress',
        payload: { assignee: who, teamTaskId, status: 'draft', note: '已委派' },
      })
    })
    ws.broadcast({ type: 'runbook.changed', taskId, stepId })
    sync.pushNow() // 把父任务的委派行推上去（团队据此认出委派者）
    sendJson(res, 201, { teamTaskId })
  })

  /** 委派行 → [打开对方 runbook]：从团队服务取对方任务的只读镜像。 */
  router.get('/steps/:id/delegation', async (_req, res, ctx) => {
    const delegation = store.delegationOf(ctx.params.id!)
    if (delegation === null) {
      sendJson(res, 404, { error: 'not_found', message: '这一步没有委派' })
      return
    }
    const cfg = team.get()
    if (!cfg.enabled) {
      sendJson(res, 200, { delegation, mirror: null, note: '团队同步没开，看不到对方进度' })
      return
    }
    try {
      const r = await fetch(teamUrl(cfg, `/api/tasks/${encodeURIComponent(delegation.teamTaskId)}`), {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (r.status === 404) {
        sendJson(res, 200, { delegation, mirror: null, note: '对方的引擎还没同步上来（对方可能不在线）' })
        return
      }
      if (!r.ok) throw new Error(`团队服务返回 HTTP ${r.status}`)
      sendJson(res, 200, { delegation, mirror: await r.json() })
    } catch (e) {
      sendJson(res, 502, { error: 'team_unreachable', message: errMessage(e) })
    }
  })

  /** 委派行 → [留言]：评论落到对方任务上（可指定对方的某一步）。 */
  router.post('/steps/:id/delegation/comment', async (_req, res, ctx) => {
    const delegation = store.delegationOf(ctx.params.id!)
    if (delegation === null) {
      sendJson(res, 404, { error: 'not_found', message: '这一步没有委派' })
      return
    }
    const parsed = z
      .object({ body: z.string().trim().min(1, '留言是空的').max(4000), stepId: z.string().nullable().optional() })
      .safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const cfg = team.get()
    if (!cfg.enabled) {
      sendJson(res, 400, { error: 'team_not_configured', message: '留言需要团队服务' })
      return
    }
    try {
      const r = await fetch(teamUrl(cfg, `/api/tasks/${encodeURIComponent(delegation.teamTaskId)}/comments`), {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: redact(parsed.data.body).text, stepId: parsed.data.stepId ?? null }),
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new Error(r.status === 404 ? '对方的任务还没同步上来' : `团队服务返回 HTTP ${r.status}`)
      sendJson(res, 201, { ok: true })
    } catch (e) {
      sendJson(res, 502, { error: 'comment_failed', message: errMessage(e) })
    }
  })

  /**
   * 记个坑（捕获时机 2 的接口）：挂在步骤血缘上，可选共享给团队。
   * 没有血缘锚点的（复制底稿前手写的步骤）共享无意义，强制 personal。
   */
  router.post('/steps/:id/lesson', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    const body = (ctx.body ?? {}) as { symptom?: string; fix?: string; condition?: string; scope?: string }
    const symptomIn = typeof body.symptom === 'string' ? body.symptom.trim() : ''
    const fixIn = typeof body.fix === 'string' ? body.fix.trim() : ''
    if (symptomIn === '' && fixIn === '') {
      sendJson(res, 400, { error: 'bad_request', message: '问和答至少写一个' })
      return
    }
    const canShare = step.lineageKey !== null
    const scope = canShare && body.scope === 'team' ? 'team' : 'personal'
    const taskId = store.taskIdOfStep(stepId)
    const lesson = store.createLesson({
      // 锚到步骤血缘（M9）：同血缘的所有 runbook 复制品都会看到这条坑
      anchorKind: canShare ? 'step_lineage' : 'free',
      anchorRef: step.lineageKey,
      condition: typeof body.condition === 'string' && body.condition !== '' ? redact(body.condition).text : null,
      symptom: redact(symptomIn).text,
      fixMd: redact(fixIn).text,
      authorId: currentUserId(),
      sourceTaskId: taskId,
      scope,
    })
    if (taskId !== null) {
      store.appendEvent({
        taskId,
        stepId,
        actorId: currentUserId(),
        kind: 'lesson_proposed',
        payload: { lessonId: lesson.id, symptom: lesson.symptom.slice(0, 80), shared: scope === 'team' },
      })
    }
    if (scope === 'team') sync.pushNow()
    sendJson(res, 201, lesson)
  })

  /**
   * 告警静音（"我能搞定"）：这段时间内这条告警不再推给发起人（团队侧随之
   * 解除；到点条件还在就重新出现）。宪法 15：执行者看得到 QB 替他发了
   * 什么，也应该能说"先别烦他"。原先这条路由只记了静音，推送时从没看过它。
   */
  router.post('/tasks/:id/alerts/snooze', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = SnoozeBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const { key, minutes } = parsed.data
    store.snoozeAlert(taskId, key, currentUserId(), minutes)
    store.appendEvent({ taskId, actorId: currentUserId(), kind: 'alert_snoozed', payload: { key, minutes } })
    ws.broadcast({ type: 'runbook.changed', taskId, stepId: null })
    sync.evaluateNow() // 决策集变了：马上推一次，发起人那边的告警随之解除
    sendJson(res, 200, { key, minutes })
  })
}
