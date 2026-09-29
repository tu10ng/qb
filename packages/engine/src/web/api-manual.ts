/**
 * 手册路由：runbook 不只是执行清单，也是可以参考、可以复用的手册。
 *
 * - 任务信息建完再补（说明、发起人、预期）——建任务只要一句"要做什么"
 * - 自己写：没有模型也能从空白开始（章节、文字、命令、代码、回显）
 * - 导入 md / org 文件：确定性解析，图片一起带上，不叫模型
 * - 从别的任务挑章节/步骤拼进来（血缘保留，挂在上面的问答跟着来）
 * - 问答：问和答可以只填一个；挂在某一步、某一章或整份文档上；没答案的
 *   可以问发起人，回答回来就填上
 * - 回显：同一步在别的任务里跑出来的样子，拿来对比
 */

import { z } from 'zod'
import {
  detectDocFormat,
  matchCondition,
  parseCondition,
  parseDocument,
  redact,
  redactSecrets,
  TaskPatch,
  type DocBlock,
  type EnvironmentFacts,
  type Lesson,
  type Param,
  type Step,
} from '@qb/core'
import type { NewStep, Store } from '@qb/store'
import { fixCommandOf } from '../agent/capture.ts'
import type { TeamSettings, Sync } from '../sync/sync.ts'
import type { Attachments } from './attachments.ts'
import { AttachmentError } from './attachments.ts'
import { errMessage, sendJson, type Router } from './router.ts'
import type { createWsHandler } from './ws.ts'

export interface ManualDeps {
  store: Store
  ws: ReturnType<typeof createWsHandler>
  attachments: Attachments
  currentUserId: () => string
  team: TeamSettings
  sync: Sync
  mount: string
}

const DocBody = z.object({
  text: z.string().min(1, '文档是空的').max(1_000_000, '文档太长（上限 100 万字符）'),
  filename: z.string().max(300).optional(),
  format: z.enum(['md', 'org']).optional(),
  /**
   * 文档里引用的图片：文件名 → 已经传上来的地址（POST /attachments 一张张
   * 传，单个请求体有 8MB 上限，一次带一堆截图会超）。
   */
  imageUrls: z.record(z.string().max(300), z.string().max(300)).default({}),
  /** 已有 runbook 时：replace = 整份换成导入的（留快照）；append = 接在末尾。 */
  mode: z.enum(['replace', 'append']).default('replace'),
})

const GraftBody = z.object({
  sourceTaskId: z.string().min(1),
  stepIds: z.array(z.string().min(1)).min(1, '要选至少一个章节或步骤').max(500),
  parentId: z.string().nullable().default(null),
  afterId: z.string().nullable().default(null),
})

const LessonBody = z.object({
  /** 问（可以空）。 */
  question: z.string().max(4000).default(''),
  /** 答（可以空）。 */
  answer: z.string().max(8000).default(''),
  /** 挂在哪：某一步 / 某一章（stepId），或整份文档（stepId 为空）。 */
  stepId: z.string().nullable().default(null),
  condition: z.string().max(500).nullable().optional(),
  scope: z.enum(['personal', 'team']).default('personal'),
})

const LessonPatchBody = z.object({
  question: z.string().max(4000).optional(),
  answer: z.string().max(8000).optional(),
  condition: z.string().max(500).nullable().optional(),
})

/** 问答的展示视图。 */
export interface QaView {
  id: string
  question: string
  answer: string
  condition: string | null
  /** 条件成立（没有条件也算 true）/ 不成立（false）/ 条件判定不了（null）。 */
  matched: boolean | null
  author: string
  mine: boolean
  status: 'personal' | 'unverified' | 'confirmed'
  stale: boolean
  hits: number
  /** 挂在哪：步骤 id（章节也是步骤）；整份文档为 null。 */
  stepId: string | null
  stepTitle: string | null
  /** 问过发起人、还没回答。 */
  askedAt: number | null
  /** 答里能直接跑的修复命令（最后一个围栏块，或单行命令）；没有就不给"按这个修"。 */
  fixCommand: string | null
  createdAt: number
}

export function registerManualRoutes(router: Router, deps: ManualDeps): void {
  const { store, ws, attachments, currentUserId, mount, sync } = deps

  const changed = (taskId: string, stepId: string | null = null): void => {
    ws.broadcast({ type: 'runbook.changed', taskId, stepId })
  }

  // ── 任务信息 ─────────────────────────────────────────────

  /** 建完再补：说明、发起人、预期、完成定义。 */
  router.patch('/tasks/:id', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = TaskPatch.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const { initiatorName, ...rest } = parsed.data
    const patch: Parameters<Store['updateTask']>[1] = { ...rest }
    if (initiatorName !== undefined) {
      // 空 = 自己；别的名字建个本机用户，同步时按名字对上团队里的人
      patch.initiatorId = initiatorName === '' ? currentUserId() : store.ensureUser(initiatorName).id
    }
    const changes = store.updateTask(taskId, patch)
    if (changes.length > 0) {
      store.appendEvent({
        taskId,
        actorId: currentUserId(),
        kind: 'task_updated',
        payload: {
          fields: changes.map((c) => c.field),
          ...(initiatorName !== undefined && changes.some((c) => c.field === 'initiatorId') ? { initiator: initiatorName === '' ? null : initiatorName } : {}),
        },
      })
      changed(taskId)
      sync.pushNow()
    }
    sendJson(res, 200, { task: store.getTask(taskId), changes: changes.map((c) => c.field) })
  })

  // ── 自己写：从空白开始 ──────────────────────────────────

  /** 空白的 runbook：不需要模型，建完直接写。已有就原样返回。 */
  router.post('/tasks/:id/runbook/blank', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const latest = store.getLatestRunbook(taskId)
    if (latest !== null) {
      sendJson(res, 200, { runbook: latest.runbook, steps: latest.steps, existing: true })
      return
    }
    const created = store.createRunbook({ taskId, createdBy: currentUserId(), origin: 'human', steps: [] })
    ws.broadcast({ type: 'runbook.updated', taskId, version: created.runbook.version })
    sendJson(res, 201, { runbook: created.runbook, steps: created.steps, existing: false })
  })

  // ── 导入 md / org ────────────────────────────────────────

  router.post('/tasks/:id/import-doc', async (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = DocBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const body = parsed.data

    // 图片已经传上来了：文档里的相对地址按文件名对上（./a.png、images/a.png 都认）。
    // 只认本机附件地址，别的一律当没带上
    const attachmentPrefix = `${mount}/api/attachments/`
    const saved = new Map<string, string>()
    for (const [name, url] of Object.entries(body.imageUrls)) {
      if (url.startsWith(attachmentPrefix) && /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(url.slice(attachmentPrefix.length))) {
        saved.set(baseName(name), url)
      }
    }

    const format = body.format ?? detectDocFormat(body.text, body.filename)
    const doc = parseDocument(body.text, format, { resolveImage: (ref) => saved.get(baseName(ref)) ?? null })
    const blocks = doc.blocks.map(toNewStep)
    if (blocks.length === 0) {
      sendJson(res, 400, { error: 'empty', message: '文档里没认出任何内容' })
      return
    }

    const result = store.inTransaction(() => {
      const latest = store.getLatestRunbook(taskId)
      const material = store.createMaterial({ taskId, kind: 'doc', text: body.text, ...(body.filename !== undefined ? { filename: body.filename } : {}), createdBy: currentUserId() })
      if (latest !== null && body.mode === 'append') {
        // 接在末尾：顶层逐个插
        let after = latest.steps.filter((s) => s.parentId === null).at(-1)?.id ?? null
        for (const b of blocks) {
          const s = store.insertStep({ runbookId: latest.runbook.id, parentId: null, afterId: after, step: b, origin: 'import' })
          after = s.id
        }
        store.appendEvent({ taskId, actorId: currentUserId(), kind: 'insert', payload: { title: body.filename ?? '导入的文档', doc: doc.stats, appended: true } })
        return { version: latest.runbook.version }
      }
      if (latest !== null) store.snapshotRunbook(latest.runbook.id, '导入文档前', currentUserId())
      const created = store.createRunbook({
        taskId,
        createdBy: currentUserId(),
        origin: 'doc',
        materialId: material.id,
        params: latest?.runbook.params ?? [],
        steps: blocks,
      })
      store.appendEvent({
        taskId,
        actorId: currentUserId(),
        kind: 'replanned',
        payload: { version: created.runbook.version, reason: `导入文档${body.filename !== undefined ? `「${body.filename}」` : ''}`, doc: doc.stats },
      })
      return { version: created.runbook.version }
    })
    store.markTaskStarted(taskId, currentUserId())
    ws.broadcast({ type: 'runbook.updated', taskId, version: result.version })
    sendJson(res, 201, {
      version: result.version,
      title: doc.title,
      stats: doc.stats,
      missingImages: [...new Set(doc.images.filter((ref) => !saved.has(baseName(ref))).map(baseName))],
    })
  })

  /** 导入时存下的图片（内容寻址，文件名即哈希）。 */
  router.get('/attachments/:name', async (_req, res, ctx) => {
    const file = await attachments.read(ctx.params.name!)
    if (file === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    res.writeHead(200, {
      'content-type': file.mediaType,
      'content-length': file.data.length,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(file.data)
  })

  /** 文字块里直接贴的图（Ctrl+V）：存下来返回地址，插进 markdown。 */
  router.post('/attachments', async (_req, res, ctx) => {
    const parsed = z.object({ base64: z.string().min(1), mediaType: z.string().min(1) }).safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: '要给图片内容' })
      return
    }
    try {
      const name = await attachments.saveImage(parsed.data.base64, parsed.data.mediaType)
      sendJson(res, 201, { url: `${mount}/api/attachments/${name}` })
    } catch (e) {
      sendJson(res, e instanceof AttachmentError ? 400 : 500, { error: 'bad_image', message: errMessage(e) })
    }
  })

  // ── 从别的任务挑步骤 ─────────────────────────────────────

  /** 能挑的任务：本机所有有 runbook 的任务（新的在前），可按标题搜。 */
  router.get('/tasks/:id/graft-sources', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const q = (ctx.query.get('q') ?? '').trim()
    const pool = q === '' ? store.listTasks({}) : store.searchTasks(q, 30)
    const sources = pool
      .filter((t) => t.id !== taskId)
      .map((t) => ({ task: t, latest: store.getLatestRunbook(t.id) }))
      .filter((x) => x.latest !== null && x.latest.steps.length > 0)
      .slice(0, 30)
      .map((x) => ({
        taskId: x.task.id,
        title: x.task.title,
        status: x.task.status,
        runbookId: x.latest!.runbook.id,
        steps: x.latest!.steps.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind, title: s.title })),
      }))
    sendJson(res, 200, { sources })
  })

  /** 把挑中的章节/步骤（连同子树）接到这份 runbook 的某个位置。 */
  router.post('/tasks/:id/graft', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    if (store.getTask(taskId) === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = GraftBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const source = store.getLatestRunbook(parsed.data.sourceTaskId)
    if (source === null) {
      sendJson(res, 404, { error: 'not_found', message: '源任务还没有 runbook' })
      return
    }
    let target = store.getLatestRunbook(taskId)
    if (target === null) {
      const created = store.createRunbook({ taskId, createdBy: currentUserId(), origin: 'human', steps: [] })
      target = { runbook: created.runbook, steps: [] }
    }
    try {
      const r = store.graftSteps({
        targetRunbookId: target.runbook.id,
        parentId: parsed.data.parentId,
        afterId: parsed.data.afterId,
        sourceRunbookId: source.runbook.id,
        stepIds: parsed.data.stepIds,
        actorId: currentUserId(),
      })
      const sourceTask = store.getTask(parsed.data.sourceTaskId)
      store.markTaskStarted(taskId, currentUserId())
      for (const s of r.inserted) {
        store.appendEvent({
          taskId,
          stepId: s.id,
          actorId: currentUserId(),
          kind: 'insert',
          payload: { title: s.title, from: sourceTask?.title ?? null, fromTaskId: parsed.data.sourceTaskId },
        })
      }
      changed(taskId)
      sendJson(res, 201, { inserted: r.inserted.map((s) => s.id), addedParams: r.addedParams })
    } catch (e) {
      sendJson(res, 400, { error: 'graft_failed', message: errMessage(e) })
    }
  })

  // ── 问答 ─────────────────────────────────────────────────

  /** 这份文档的全部问答：挂在各步、各章、整份文档上的。 */
  router.get('/tasks/:id/qa', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = store.getLatestRunbook(taskId)
    if (latest === null) {
      sendJson(res, 200, { items: [] })
      return
    }
    sendJson(res, 200, { items: qaOf(store, latest.runbook.lineageKey, latest.steps, latest.runbook.params) })
  })

  router.post('/tasks/:id/qa', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const parsed = LessonBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const body = parsed.data
    if (body.question.trim() === '' && body.answer.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: '问和答至少写一个' })
      return
    }
    const latest = store.getLatestRunbook(taskId)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found', message: '还没有 runbook' })
      return
    }
    const step = body.stepId !== null ? latest.steps.find((s) => s.id === body.stepId) : undefined
    if (body.stepId !== null && step === undefined) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    // 锚点：步骤（章节也是步骤）的血缘；整份文档用文档血缘。锚不上就不共享
    const anchor = step !== undefined ? (step.lineageKey !== null ? { kind: 'step_lineage' as const, ref: step.lineageKey } : null) : latest.runbook.lineageKey !== null ? { kind: 'runbook_lineage' as const, ref: latest.runbook.lineageKey } : null
    const params = latest.runbook.params
    const clean = (t: string): string => redactSecrets(redact(t).text, params).text.trim()
    const lesson = store.createLesson({
      anchorKind: anchor?.kind ?? 'free',
      anchorRef: anchor?.ref ?? null,
      symptom: clean(body.question),
      fixMd: clean(body.answer),
      condition: body.condition != null && body.condition.trim() !== '' ? clean(body.condition) : null,
      authorId: currentUserId(),
      sourceTaskId: taskId,
      scope: anchor !== null ? body.scope : 'personal',
    })
    store.appendEvent({
      taskId,
      stepId: step?.id ?? null,
      actorId: currentUserId(),
      kind: 'lesson_proposed',
      payload: { lessonId: lesson.id, symptom: (lesson.symptom || lesson.fixMd).slice(0, 80), shared: lesson.scope === 'team' },
    })
    changed(taskId, step?.id ?? null)
    if (lesson.scope === 'team') sync.pushNow()
    sendJson(res, 201, { item: toQa(store, lesson, latest.steps, params) })
  })

  router.patch('/qa/:id', (_req, res, ctx) => {
    const l = store.lessonById(ctx.params.id!)
    if (l === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (l.authorName !== null) {
      sendJson(res, 403, { error: 'forbidden', message: '这是同事记的，只有他能改（可以另记一条）' })
      return
    }
    const parsed = LessonPatchBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const taskId = l.sourceTaskId
    const params = taskId !== null ? (store.getLatestRunbook(taskId)?.runbook.params ?? []) : []
    const clean = (t: string): string => redactSecrets(redact(t).text, params).text.trim()
    try {
      const next = store.updateLesson(l.id, {
        ...(parsed.data.question !== undefined ? { symptom: clean(parsed.data.question) } : {}),
        ...(parsed.data.answer !== undefined ? { fixMd: clean(parsed.data.answer) } : {}),
        ...(parsed.data.condition !== undefined ? { condition: parsed.data.condition === null || parsed.data.condition.trim() === '' ? null : clean(parsed.data.condition) } : {}),
      })
      if (taskId !== null) changed(taskId)
      if (next.scope === 'team') sync.pushNow()
      sendJson(res, 200, { ok: true })
    } catch (e) {
      sendJson(res, 400, { error: 'bad_request', message: errMessage(e) })
    }
  })

  router.delete('/qa/:id', (_req, res, ctx) => {
    const l = store.lessonById(ctx.params.id!)
    if (l === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (!store.deleteLesson(l.id)) {
      sendJson(res, 409, { error: 'shared', message: '已经共享给团队的删不掉（别人手里已经有了），可以改' })
      return
    }
    if (l.sourceTaskId !== null) changed(l.sourceTaskId)
    sendJson(res, 200, { ok: true })
  })

  // ── 回显 ─────────────────────────────────────────────────

  /**
   * 这一步的回显：参考回显、这次历次运行/粘贴的输出、同一步在别的任务里
   * 跑出来的（同血缘）。界面拿来对比"这个版本和上个版本哪里不一样"。
   */
  router.get('/steps/:id/outputs', (_req, res, ctx) => {
    const step = store.getStep(ctx.params.id!)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const mine = store.listEvidence(step.id).filter((e) => e.text !== null && e.imagePath === null)
    const others = step.lineageKey !== null ? store.lineageOutputs(step.lineageKey, step.id, 10) : []
    sendJson(res, 200, {
      reference: step.refMd,
      mine: mine.reverse().map((e) => ({ id: e.id, source: e.source, text: e.text, exitCode: e.exitCode, createdAt: e.createdAt })),
      others: others.map((o) => ({ id: o.evidence.id, taskId: o.taskId, taskTitle: o.taskTitle, source: o.evidence.source, text: o.evidence.text, createdAt: o.evidence.createdAt })),
    })
  })

  /** 把某次输出设成参考回显（以后跑的都拿它比）。 */
  router.post('/steps/:id/reference', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    const taskId = store.taskIdOfStep(stepId)
    if (step === null || taskId === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = z.object({ evidenceId: z.string().optional(), text: z.string().max(64 * 1024).optional() }).safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: '要给 evidenceId 或 text' })
      return
    }
    let text = parsed.data.text
    if (parsed.data.evidenceId !== undefined) {
      const ev = store.getEvidence(parsed.data.evidenceId)
      if (ev === null || ev.text === null) {
        sendJson(res, 404, { error: 'not_found', message: '这次输出不在了' })
        return
      }
      text = ev.text
    }
    if (text === undefined) {
      sendJson(res, 400, { error: 'bad_request', message: '要给 evidenceId 或 text' })
      return
    }
    const refMd = '```text\n' + text.replace(/```/g, 'ˋˋˋ').trimEnd() + '\n```'
    const { changes } = store.updateStep(stepId, { refMd }, { expectedRev: step.rev, actorId: currentUserId() })
    if (changes.length > 0) {
      store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'edit', payload: { changes } })
      changed(taskId, stepId)
    }
    sendJson(res, 200, { refMd })
  })
}

/** 文档血缘上的、以及各步骤血缘上的问答，按文档顺序排好。 */
export function qaOf(store: Store, docLineage: string | null, steps: Step[], params: Param[]): QaView[] {
  const lineages = [...new Set(steps.map((s) => s.lineageKey).filter((k): k is string => k !== null))]
  const onSteps = store.lessonsForLineages(lineages)
  const onDoc = docLineage !== null ? store.lessonsForDoc(docLineage) : []
  const index = new Map(steps.map((s, i) => [s.id, i]))
  const env = store.listEnvironments()[0]?.facts ?? null
  return [...onDoc, ...onSteps]
    .map((l) => toQa(store, l, steps, params, env))
    .sort((a, b) => {
      const ia = a.stepId === null ? -1 : (index.get(a.stepId) ?? 1e9)
      const ib = b.stepId === null ? -1 : (index.get(b.stepId) ?? 1e9)
      return ia - ib || a.createdAt - b.createdAt
    })
}

export function toQa(store: Store, l: Lesson, steps: Step[], params: Param[], env?: EnvironmentFacts | null): QaView {
  const step = l.anchorKind === 'step_lineage' ? steps.find((s) => s.lineageKey === l.anchorRef) : undefined
  // 没有条件 = 成立（挂在这一步上本身就算相关）；条件写成了散文判定不了 = null
  const parsed = parseCondition(l.condition)
  const matched = l.condition === null || l.condition.trim() === '' ? true : parsed === null ? null : matchCondition(parsed, params, env ?? store.listEnvironments()[0]?.facts ?? null)
  const asked = store.openQuestionForLesson(l.id)
  return {
    id: l.id,
    question: l.symptom,
    answer: l.fixMd,
    condition: l.condition,
    matched,
    author: l.authorName ?? store.getUser(l.authorId)?.displayName ?? '未知',
    mine: l.authorName === null,
    status: l.scope === 'team' ? (l.confirmedAt !== null ? 'confirmed' : 'unverified') : 'personal',
    stale: l.staleAt !== null,
    hits: l.hitCount,
    stepId: step?.id ?? null,
    stepTitle: step?.title ?? null,
    askedAt: asked?.createdAt ?? null,
    fixCommand: l.fixMd.trim() === '' ? null : fixCommandOf(l.fixMd),
    createdAt: l.createdAt,
  }
}

/** 解析出来的文档块 → 可以写库的步骤树。 */
function toNewStep(b: DocBlock): NewStep {
  return {
    kind: b.kind,
    title: b.title,
    titleAuto: b.titleAuto,
    ...(b.bodyMd !== undefined ? { bodyMd: b.bodyMd } : {}),
    ...(b.command !== undefined ? { command: b.command } : {}),
    ...(b.lang !== undefined ? { lang: b.lang } : {}),
    ...(b.refMd !== undefined ? { refMd: b.refMd } : {}),
    ...(b.sourceRef !== undefined ? { sourceRef: b.sourceRef } : {}),
    ...(b.children !== undefined && b.children.length > 0 ? { children: b.children.map(toNewStep) } : {}),
  }
}

/** 地址里的文件名（./images/a.png → a.png），图片按它对上。 */
function baseName(ref: string): string {
  const clean = decodeURIComponentSafe(ref.split(/[?#]/)[0]!)
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1).toLowerCase()
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
