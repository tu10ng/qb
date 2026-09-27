/**
 * M8 路由：团队同步配置与"问发起人"的正式通道。
 *
 * 配好团队服务后，问发起人从"临时 · 复制到 IM"升级为真实发送：
 * 求助存本地（答案回流时挂回这一步）→ 事件 → 立刻推给团队服务 →
 * 发起人回答经同步回流，出现在这一步的 QB 面板里。
 *
 * 委派（delegate）：把这步变成对方的任务，经团队服务的 dispatch 通道
 * 派出去；对方引擎几秒内收到，进度回流到委派行上。
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
})

const DelegateBody = z.object({
  assigneeName: z.string().trim().min(1, '要填对方名字'),
})

export function registerTeamRoutes(router: Router, deps: TeamDeps): void {
  const { store, team, sync, currentUserId, userName } = deps

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

  /**
   * 委派这步给别人：生成对方的任务（本机存父结构），同时通过团队服务
   * 的 dispatch 通道派出去——对方引擎几秒内收到。
   *
   * 配好团队服务才可委派（不然对方收不到）；没配时明确报错。
   */
  router.post('/steps/:id/delegate', async (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    if (step === null) {
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

    const taskId = store.taskIdOfStep(stepId)
    if (taskId === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const task = store.getTask(taskId)!
    const me = store.getUserByName(userName())
    const assignee = store.ensureUser(parsed.data.assigneeName)

    // 生成子任务：发起人 = 委派者（本机用户），执行者 = 对方
    const childTask = store.createTask({
      title: step.title.replace(/^→ [^:]+:\s*/, ''), // 去掉前缀还原标题
      briefMd: [
        `（由委派产生——原任务「${task.title}」的步骤「${step.title}」）`,
        step.whyMd !== null ? `目的：${step.whyMd}` : '',
        step.command !== null ? `参考命令：\n\`\`\`\n${step.command}\n\`\`\`` : '',
      ].filter(Boolean).join('\n\n'),
      initiatorId: me !== null ? me.id : currentUserId(),
      assigneeId: assignee.id,
      parentStepId: stepId,
    })
    store.appendEvent({ taskId: childTask.id, actorId: currentUserId(), kind: 'task_created', payload: { delegated: true, fromTask: task.title } })
    store.appendEvent({
      taskId,
      stepId,
      actorId: currentUserId(),
      kind: 'delegate_progress',
      payload: { childTaskId: childTask.id, assignee: parsed.data.assigneeName, note: '已委派' },
    })

    // 经团队服务派出去（对方引擎在 pullDown 里收到 kind=task）
    try {
      const r = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/dispatch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: childTask.title,
          briefMd: redact(childTask.briefMd).text,
          assigneeName: parsed.data.assigneeName,
          parentStepId: stepId,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        throw new Error(`团队服务返回 HTTP ${r.status}${body !== '' ? `：${body.slice(0, 120)}` : ''}`)
      }
      const { taskId: remoteId } = (await r.json()) as { taskId: string }
      // 用团队服务生成的 id 替换本地的（两边一致才好关联）
      // SQLite 不方便改 PK——写 delegate_task_id 关联即可
      void remoteId
    } catch (e) {
      sendJson(res, 502, { error: 'dispatch_failed', message: `委派失败（任务已在本地创建）：${errMessage(e)}` })
      return
    }

    sync.pushNow() // 把父任务的委派事件推上去
    sendJson(res, 201, { taskId: childTask.id })
  })

  /**
   * 沉淀成坑：把一次求助-回答对变成 personal 坑。
   * 界面上出现在发起人回答到达后的 [沉淀成坑] 按钮。
   */
  router.post('/steps/:id/lesson', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    const body = (ctx.body ?? {}) as { symptom?: string; fix?: string; condition?: string }
    if (typeof body.symptom !== 'string' || body.symptom.trim() === '' || typeof body.fix !== 'string' || body.fix.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: 'symptom 和 fix 不能为空' })
      return
    }
    const taskId = store.taskIdOfStep(stepId)
    const lesson = store.createLesson({
      // 锚到步骤血缘（M9）：同血缘的所有 runbook 复制品都会看到这条坑
      anchorKind: step.lineageKey !== null ? 'step_lineage' : 'free',
      anchorRef: step.lineageKey,
      condition: typeof body.condition === 'string' && body.condition !== '' ? body.condition : null,
      symptom: redact(body.symptom).text,
      fixMd: redact(body.fix).text,
      authorId: currentUserId(),
      sourceTaskId: taskId,
      scope: 'personal',
    })
    if (taskId !== null) {
      store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'lesson_proposed', payload: { lessonId: lesson.id, symptom: lesson.symptom.slice(0, 80) } })
    }
    sendJson(res, 201, lesson)
  })

  /**
   * 告警静音（"我能搞定"）：30 分钟内不出声。
   * QB 检测到红告警后推给团队服务 → 发起人知道了；执行者觉得"我能搞定"
   * 就静音，避免发起人被反复打扰。宪法 15：执行者看得到 QB 替他发了什么，
   * 也应该能说"先别烦他"。
   */
  router.post('/tasks/:id/alerts/snooze', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const body = (ctx.body ?? {}) as { key?: string; minutes?: number }
    if (typeof body.key !== 'string' || body.key === '') {
      sendJson(res, 400, { error: 'bad_request', message: '要给告警 key' })
      return
    }
    const minutes = typeof body.minutes === 'number' && body.minutes > 0 ? Math.min(body.minutes, 120) : 30
    store.snoozeAlert(taskId, body.key, currentUserId(), minutes)
    store.appendEvent({
      taskId,
      actorId: currentUserId(),
      kind: 'edit',
      payload: { changes: [{ field: 'alert', before: body.key, after: `静音 ${minutes} 分钟` }], snooze: body.key },
    })
    sendJson(res, 200, { key: body.key, minutes })
  })
}
