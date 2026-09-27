/**
 * M9 路由：坑的三层数据、捕获提议、命中统计、按坑修复、复盘清单、
 * 底稿提议的上传与应用。
 *
 * 三层显示的数据源是 GET /tasks/:id/lessons：按步骤血缘把坑分组，
 * 条件确定性判定（@qb/core/conditions）决定第一层还是第二层；
 * 失败时浮出（第三层）是 UI 行为，数据同一份。
 */

import { z } from 'zod'
import { matchCondition, parseCondition, redact, type EnvironmentFacts, type Lesson, type Param } from '@qb/core'
import type { LessonOfferRow, Store } from '@qb/store'
import type { TeamSettings, Sync } from '../sync/sync.ts'
import { fixCommandOf } from '../agent/capture.ts'
import { errMessage, sendJson, type Router } from './router.ts'
import type { createWsHandler } from './ws.ts'

export interface M9Deps {
  store: Store
  ws: ReturnType<typeof createWsHandler>
  currentUserId: () => string
  team: TeamSettings
  sync: Sync
}

export interface LessonView {
  id: string
  symptom: string
  cause: string | null
  fixMd: string
  condition: string | null
  /** true=条件成立（第一层）；false=不成立；null=无法判定（都进第二层）。 */
  matched: boolean | null
  author: string
  mine: boolean
  status: 'personal' | 'unverified' | 'confirmed'
  stale: boolean
  hits: number
  misses: number
  createdAt: number
}

export function registerM9Routes(router: Router, deps: M9Deps): void {
  const { store, ws, currentUserId, team, sync } = deps

  const changed = (taskId: string, stepId: string | null): void => {
    ws.broadcast({ type: 'runbook.changed', taskId, stepId })
  }

  // ── 三层数据 ─────────────────────────────────────────────

  /** 步骤 → 两层坑。UI 拿到后：第一层一行预警，第二层折叠计数，失败全展开。 */
  router.get('/tasks/:id/lessons', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = store.getLatestRunbook(taskId)
    if (latest === null) {
      sendJson(res, 200, { steps: {} })
      return
    }
    const lineages = [...new Set(latest.steps.map((s) => s.lineageKey).filter((k): k is string => k !== null))]
    const lessons = store.lessonsForLineages(lineages)
    const env: EnvironmentFacts | null = store.listEnvironments()[0]?.facts ?? null
    const params: Param[] = latest.runbook.params

    const steps: Record<string, { layer1: LessonView[]; layer2: LessonView[] }> = {}
    for (const l of lessons) {
      if (l.anchorRef === null) continue
      const view = toView(store, l, params, env)
      const bucket = steps[l.anchorRef] ?? { layer1: [], layer2: [] }
      // 第一层：条件匹配且未过期。刚共享的（未验证）也上第一层，但带
      // "未验证"标注——同事在这一步刚踩的坑，现在就该看见（验收 M9-2）
      const first = view.matched === true && !view.stale
      ;(first ? bucket.layer1 : bucket.layer2).push(view)
      steps[l.anchorRef] = bucket
    }

    // 按 lineage 分组是给步骤用的；同一血缘在一份 runbook 里只有一步，
    // 直接按 lineageKey 落到步骤 id 上
    const byStep: Record<string, { layer1: LessonView[]; layer2: LessonView[] }> = {}
    for (const s of latest.steps) {
      if (s.lineageKey === null) continue
      const bucket = steps[s.lineageKey]
      if (bucket !== undefined) byStep[s.id] = bucket
    }
    sendJson(res, 200, { steps: byStep })
  })

  // ── 捕获提议 ─────────────────────────────────────────────

  router.get('/tasks/:id/lesson-offers', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const offers = store.listLessonOffers(taskId).map((o) => ({
      ...o,
      stepTitle: o.stepId !== null ? (store.getStep(o.stepId)?.title ?? null) : null,
    }))
    sendJson(res, 200, { offers })
  })

  const AcceptBody = z.object({
    symptom: z.string().trim().min(1).max(4000).optional(),
    fixMd: z.string().trim().min(1).max(8000).optional(),
    condition: z.string().trim().max(500).nullable().optional(),
    cause: z.string().trim().max(2000).nullable().optional(),
    /** personal=只记给自己；team=脱敏后共享（默认）。 */
    scope: z.enum(['personal', 'team']).default('team'),
  })

  const QuestionLessonBody = z.object({
    symptom: z.string().trim().min(1).max(4000).optional(),
    fixMd: z.string().trim().min(1).max(8000).optional(),
    condition: z.string().trim().max(500).nullable().optional(),
    scope: z.enum(['personal', 'team']).default('team'),
  })

  router.post('/lesson-offers/:id/accept', async (_req, res, ctx) => {
    const offer = store.lessonOfferById(ctx.params.id!)
    if (offer === null || offer.status !== 'pending') {
      sendJson(res, 404, { error: 'not_found', message: '提议不存在或已处理' })
      return
    }
    const parsed = AcceptBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const body = parsed.data

    // 偏离底稿：不是记坑，是发给底稿负责人
    if (offer.kind === 'deviation') {
      const step = offer.stepId !== null ? store.getStep(offer.stepId) : null
      const cfg = team.get()
      if (!cfg.enabled) {
        sendJson(res, 400, { error: 'team_not_configured', message: '带回底稿需要团队服务。到「设置 · 团队」配置后再试。' })
        return
      }
      if (step === null || step.lineageKey === null) {
        sendJson(res, 409, { error: 'gone', message: '步骤已经不在了' })
        return
      }
      try {
        const task = store.getTask(offer.taskId)
        const r = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/proposals`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            lineageKey: step.lineageKey,
            stepTitle: step.title,
            beforeMd: redact(String(offer.payload.before ?? '')).text,
            afterMd: redact(String(offer.payload.after ?? step.command ?? '')).text,
            fromTaskId: offer.taskId,
            fromTaskTitle: task?.title ?? null,
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!r.ok) throw new Error(`团队服务返回 HTTP ${r.status}`)
        const { id } = (await r.json()) as { id: string }
        store.patchLessonOfferPayload(offer.id, { remoteId: id, sentAt: Date.now() })
        store.setLessonOfferStatus(offer.id, 'accepted')
        store.appendEvent({
          taskId: offer.taskId,
          stepId: offer.stepId,
          actorId: currentUserId(),
          kind: 'base_proposal',
          payload: { sent: true, stepTitle: step.title, remoteId: id },
        })
        changed(offer.taskId, offer.stepId)
        sendJson(res, 200, { sent: true, remoteId: id })
      } catch (e) {
        sendJson(res, 502, { error: 'proposal_failed', message: `没送出去（稍后再试）：${errMessage(e)}` })
      }
      return
    }

    // 别人的底稿提议：应用到自己手里的底稿（同血缘、非来源任务）
    if (offer.kind === 'proposal') {
      const outcome = applyProposal(store, currentUserId(), offer)
      const cfg = team.get()
      if (cfg.enabled) {
        const remoteId = typeof offer.payload.remoteId === 'string' ? offer.payload.remoteId : null
        if (remoteId !== null) {
          void fetch(`${cfg.url.replace(/\/+$/, '')}/api/proposals/${remoteId}/decide`, {
            method: 'POST',
            headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ outcome }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined) // 回报失败不阻塞本地应用
        }
      }
      changed(offer.taskId, offer.stepId)
      sendJson(res, 200, { outcome })
      return
    }

    // 记成坑（fix / question / situation）
    const step = offer.stepId !== null ? store.getStep(offer.stepId) : null
    const defaultSymptom =
      offer.kind === 'question'
        ? String(offer.payload.question ?? '')
        : offer.kind === 'situation'
          ? `情况变了：${String(offer.payload.reason ?? '')}`
          : String(offer.payload.symptom ?? '')
    // 默认修法只放改后的命令（带围栏）——fixCommandOf 取围栏块当修复命令，
    // 放"改前"会把坏命令当修法
    const defaultFix =
      offer.kind === 'fix'
        ? `\`\`\`\n${String(offer.payload.after ?? '')}\n\`\`\``
        : offer.kind === 'question'
          ? String(offer.payload.answer ?? '')
          : '见任务时间线'
    const symptom = redact(body.symptom ?? defaultSymptom).text
    const fixMd = redact(body.fixMd ?? defaultFix).text
    if (symptom === '' || fixMd === '') {
      sendJson(res, 400, { error: 'bad_request', message: '症状和修法不能为空' })
      return
    }

    // 没有血缘锚点的坑共享无意义（别人收不到）——强制 personal
    const scope = step?.lineageKey != null ? body.scope : 'personal'
    const lesson = store.createLesson({
      anchorKind: step?.lineageKey != null ? 'step_lineage' : 'free',
      anchorRef: step?.lineageKey ?? null,
      condition: body.condition != null && body.condition !== '' ? redact(body.condition).text : null,
      cause: body.cause != null && body.cause !== '' ? redact(body.cause).text : null,
      symptom,
      fixMd,
      authorId: currentUserId(),
      sourceTaskId: offer.taskId,
      scope,
    })
    if (offer.kind === 'question' && typeof offer.payload.questionId === 'string') {
      store.updateQuestionLesson(offer.payload.questionId, lesson.id)
    }
    store.setLessonOfferStatus(offer.id, 'accepted')
    store.appendEvent({
      taskId: offer.taskId,
      stepId: offer.stepId,
      actorId: currentUserId(),
      kind: 'lesson_proposed',
      payload: { lessonId: lesson.id, symptom: symptom.slice(0, 80), shared: scope === 'team' },
    })
    changed(offer.taskId, offer.stepId)
    if (scope === 'team') sync.pushNow()
    sendJson(res, 201, { lesson: toView(store, lesson, [], null) })
  })

  router.post('/lesson-offers/:id/dismiss', async (_req, res, ctx) => {
    const offer = store.lessonOfferById(ctx.params.id!)
    if (offer === null || offer.status !== 'pending') {
      sendJson(res, 404, { error: 'not_found', message: '提议不存在或已处理' })
      return
    }
    store.setLessonOfferStatus(offer.id, 'dismissed')
    // 别人的底稿提议：拒绝也告诉团队一声（提议人好知道）
    if (offer.kind === 'proposal') {
      const cfg = team.get()
      const remoteId = typeof offer.payload.remoteId === 'string' ? offer.payload.remoteId : null
      if (cfg.enabled && remoteId !== null) {
        void fetch(`${cfg.url.replace(/\/+$/, '')}/api/proposals/${remoteId}/decide`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ outcome: 'declined' }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
      }
    }
    changed(offer.taskId, offer.stepId)
    sendJson(res, 200, { ok: true })
  })

  // ── 命中统计 / 按这个修 ─────────────────────────────────

  router.post('/lessons/:id/hit', (_req, res, ctx) => {
    const l = store.lessonById(ctx.params.id!)
    if (l === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    store.recordLessonHit(l.id)
    sendJson(res, 200, { ok: true })
  })

  router.post('/lessons/:id/miss', (_req, res, ctx) => {
    const l = store.lessonById(ctx.params.id!)
    if (l === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const after = store.recordLessonMiss(l.id)
    sendJson(res, 200, { ok: true, stale: after?.staleAt != null })
  })

  /**
   * 按这个修：在失败步骤后面插入修复步骤（命令来自坑的修法，sourceRef
   * 记着坑 id——跑通时自动帮上一次）。插完由界面直接发起运行。
   */
  router.post('/lessons/:id/apply', (_req, res, ctx) => {
    const lesson = store.lessonById(ctx.params.id!)
    if (lesson === null) {
      sendJson(res, 404, { error: 'not_found', message: '坑不存在' })
      return
    }
    const body = (ctx.body ?? {}) as { stepId?: string }
    if (typeof body.stepId !== 'string') {
      sendJson(res, 400, { error: 'bad_request', message: '要给 stepId（插到哪一步后面）' })
      return
    }
    const step = store.getStep(body.stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    const command = fixCommandOf(lesson.fixMd)
    if (command === null) {
      sendJson(res, 422, { error: 'no_command', message: '这条坑的修法里没有可执行的命令' })
      return
    }
    const fixStep = store.insertStep({
      runbookId: step.runbookId,
      parentId: step.parentId,
      afterId: step.id,
      step: {
        kind: 'command',
        title: `按坑修复：${lesson.symptom.slice(0, 30)}`,
        whyMd: `来自${lesson.authorName ?? '我'}的坑：${lesson.symptom.slice(0, 120)}`,
        whySource: `lesson:${lesson.id}`,
        command,
        sourceRef: `lesson:${lesson.id}`,
      },
      origin: 'human',
    })
    const taskId = store.taskIdOfStep(fixStep.id)
    if (taskId !== null) {
      store.appendEvent({
        taskId,
        stepId: fixStep.id,
        actorId: currentUserId(),
        kind: 'insert',
        payload: { title: fixStep.title, byLesson: lesson.id },
      })
      changed(taskId, fixStep.id)
    }
    sendJson(res, 201, { step: fixStep })
  })

  // ── 求助沉淀 / 手动记坑 ─────────────────────────────────

  /** 发起人的回答直接沉淀成坑（卡片预填好，也可手动改）。 */
  router.post('/questions/:id/lesson', (_req, res, ctx) => {
    const q = store.getQuestion(ctx.params.id!)
    if (q === null) {
      sendJson(res, 404, { error: 'not_found', message: '求助不存在' })
      return
    }
    if (q.answerMd === null) {
      sendJson(res, 409, { error: 'unanswered', message: '这条求助还没有回答' })
      return
    }
    const parsed = QuestionLessonBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const body = parsed.data
    const symptom = redact(body.symptom ?? q.bodyMd).text
    const fixMd = redact(body.fixMd ?? q.answerMd).text
    const step = q.stepId !== null ? store.getStep(q.stepId) : null
    const scope = step?.lineageKey != null ? body.scope : 'personal'
    const lesson = store.createLesson({
      anchorKind: step?.lineageKey != null ? 'step_lineage' : 'free',
      anchorRef: step?.lineageKey ?? null,
      condition: body.condition != null && body.condition !== '' ? redact(body.condition).text : null,
      symptom,
      fixMd,
      authorId: currentUserId(),
      sourceTaskId: q.taskId,
      scope,
    })
    store.updateQuestionLesson(q.id, lesson.id)
    store.appendEvent({
      taskId: q.taskId,
      stepId: q.stepId,
      actorId: currentUserId(),
      kind: 'lesson_proposed',
      payload: { lessonId: lesson.id, symptom: symptom.slice(0, 80), fromQuestion: q.id, shared: scope === 'team' },
    })
    changed(q.taskId, q.stepId)
    if (scope === 'team') sync.pushNow()
    sendJson(res, 201, { lesson: { id: lesson.id } })
  })

  // ── 复盘清单 ────────────────────────────────────────────

  /** 任务完成时把候选列一遍：待确认的提议 + 已回答没沉淀的求助。 */
  router.get('/tasks/:id/retro', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const offers = store.listLessonOffers(taskId).map((o) => ({
      ...o,
      stepTitle: o.stepId !== null ? (store.getStep(o.stepId)?.title ?? null) : null,
    }))
    const pendingQuestionIds = new Set(
      offers.filter((o) => o.kind === 'question' && typeof o.payload.questionId === 'string').map((o) => String(o.payload.questionId)),
    )
    const questions = store
      .questionsOfTask(taskId)
      .filter((q) => q.answerMd !== null && q.lessonId === null && !pendingQuestionIds.has(q.id))
    sendJson(res, 200, { offers, questions })
  })
}

function toView(store: Store, l: Lesson, params: Param[], env: EnvironmentFacts | null): LessonView {
  // 条件是自由文本（解析不了，如导入生成的「步骤「标题」」）→ 无法判定，
  // 进第二层——conditions 模块的文档语义与方案 §6.3 一致
  const parsed = parseCondition(l.condition)
  const matched = l.condition !== null && l.condition.trim() !== '' && parsed === null ? null : matchCondition(parsed, params, env)
  return {
    id: l.id,
    symptom: l.symptom,
    cause: l.cause,
    fixMd: l.fixMd,
    condition: l.condition,
    matched,
    author: l.authorName ?? store.getUser(l.authorId)?.displayName ?? '未知',
    mine: l.authorName === null,
    status: l.scope === 'team' ? (l.confirmedAt !== null ? 'confirmed' : 'unverified') : 'personal',
    stale: l.staleAt !== null,
    hits: l.hitCount,
    misses: l.missCount,
    createdAt: l.createdAt,
  }
}

/**
 * 应用别人的底稿提议：找自己手里同血缘、且命令还是 before 的步骤
 * （不是 before 的标冲突，不盲改），改完记 edit 事件。
 * 注意 offer.taskId 是提议在本机落地的任务（sync 找到的同血缘任务），
 * 不是提议人的任务——那是对方机器上的，本地不存在，不能跳过。
 */
function applyProposal(store: Store, actorId: string, offer: LessonOfferRow): 'accepted' | 'declined' | 'conflict' {
  const lineageKey = String(offer.payload.lineageKey ?? '')
  const before = String(offer.payload.before ?? '')
  const after = String(offer.payload.after ?? '')
  const stepTitle = String(offer.payload.stepTitle ?? '')
  const fromName = String(offer.payload.fromName ?? '')
  if (lineageKey === '' || after === '') return 'declined'

  // 自己所有任务里找同血缘的最新 runbook 步骤
  let applied = 0
  let conflict = false
  for (const task of store.listTasks({})) {
    const latest = store.getLatestRunbook(task.id)
    if (latest === null) continue
    const step = latest.steps.find((s) => s.lineageKey === lineageKey)
    if (step === undefined) continue
    if (step.command !== before) {
      conflict = true
      continue
    }
    store.updateStep(step.id, { command: after }, { expectedRev: step.rev, actorId })
    store.appendEvent({
      taskId: task.id,
      stepId: step.id,
      actorId,
      kind: 'edit',
      payload: { changes: [{ field: 'command', before, after }], source: 'base_proposal', stepTitle, by: fromName },
    })
    applied++
  }
  const outcome = applied > 0 ? 'accepted' : conflict ? 'conflict' : 'declined'
  store.setLessonOfferStatus(offer.id, 'accepted')
  store.appendEvent({
    taskId: offer.taskId,
    stepId: offer.stepId,
    actorId,
    kind: 'base_proposal',
    payload: { applied: outcome, stepTitle },
  })
  return outcome
}
