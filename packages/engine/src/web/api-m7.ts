/**
 * M7 路由：从已有的开始 + 参数。
 *
 * 素材 → 忠实导入（模式 B）；底稿 → 复制（模式 A 第一步）→ 差异提议 →
 * 逐项接受；参数的就地修改与提取建议；一段终端输出分流回各步（L0.5）。
 * 确定性的校验（保真/覆盖/匹配）都在这里跑，不指望模型自觉。
 */

import { z } from 'zod'
import { checkExpectation, literalSuggestions, matchBlocks, redact, renderCommand, sanitizeText, splitTranscript, tailCap, toParamName, checkFidelity, type Expectation, type Param, type StepStatus, type Verdict } from '@qb/core'
import type { Store } from '@qb/server'
import type { Llm } from '../llm/port.ts'
import { importMaterial } from '../agent/import.ts'
import { proposeAdapt } from '../agent/adapt.ts'
import { partialSteps } from '../agent/draft.ts'
import type { Jobs } from './jobs.ts'
import { errMessage, sendJson, type Router } from './router.ts'
import type { createWsHandler } from './ws.ts'

export interface M7Deps {
  store: Store
  ws: ReturnType<typeof createWsHandler>
  jobs: Jobs
  llm: Llm
  currentUserId: () => string
  prompts: { persona: string; import: string; adapt: string }
}

const ParamBody = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, '参数名要大写下划线'),
  value: z.string(),
  description: z.string().optional(),
  source: z.enum(['origin', 'base', 'mine', 'qb_guess', 'env']).optional(),
  secret: z.boolean().optional(),
})

const MaterialBody = z.object({
  kind: z.enum(['doc', 'script', 'chat', 'terminal', 'image-text']).catch('doc'),
  text: z.string().min(1, '素材内容是空的'),
  filename: z.string().optional(),
})

const AdaptApplyBody = z.object({
  paramChanges: z.array(z.object({ name: z.string(), to: z.string() })).default([]),
  newParams: z.array(ParamBody).default([]),
  stepEdits: z.array(z.object({ stepId: z.string(), command: z.string().min(1) })).default([]),
  reason: z.string().optional(),
})

const SuggestApplyBody = z.object({
  items: z.array(z.object({ value: z.string().min(1), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) })).min(1),
})

export function registerM7Routes(router: Router, deps: M7Deps): void {
  const { store, ws, jobs, llm, currentUserId, prompts } = deps

  const changed = (taskId: string, stepId: string | null = null): void => {
    ws.broadcast({ type: 'runbook.changed', taskId, stepId })
  }

  const latestOf = (taskId: string) => store.getLatestRunbook(taskId)

  // ── 素材 ─────────────────────────────────────────────────

  router.post('/tasks/:id/material', (_req, res, ctx) => {
    const task = store.getTask(ctx.params.id!)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = MaterialBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const m = store.createMaterial({ taskId: task.id, ...parsed.data, createdBy: currentUserId() })
    sendJson(res, 201, m)
  })

  // ── 导入（模式 B）─────────────────────────────────────────

  router.post('/tasks/:id/import', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const body = (ctx.body ?? {}) as { materialId?: string }
    const material =
      body.materialId !== undefined ? store.getMaterial(body.materialId) : null
    if (material === null || material.taskId !== taskId) {
      sendJson(res, 404, { error: 'not_found', message: '素材不存在（先贴进来）' })
      return
    }

    const { job, existing } = jobs.start('import', taskId, async (report) => {
      let lastPush = 0
      const imported = await importMaterial(
        llm,
        prompts.persona,
        prompts.import,
        { material: material.text, environments: store.listEnvironments() },
        {
          onPartial: (partial) => {
            const steps = partialSteps(partial)
            report(steps.length === 0 ? '开始整理' : `已整理 ${steps.length} 步`)
            const now = Date.now()
            if (now - lastPush >= 250) {
              lastPush = now
              ws.broadcast({ type: 'job.partial', kind: 'import', subjectId: taskId, steps })
            }
          },
        },
      )

      const before = latestOf(taskId)
      if (before !== null) store.snapshotRunbook(before.runbook.id, '导入素材前', currentUserId())

      const params: Param[] = imported.params.map((p) => ({
        name: p.name,
        value: p.value,
        source: 'origin',
        secret: false,
        ...(p.description !== undefined ? { description: p.description } : {}),
      }))

      const result = store.createRunbook({
        taskId,
        createdBy: currentUserId(),
        origin: 'import',
        params,
        steps: imported.steps as Parameters<Store['createRunbook']>[0]['steps'],
      })

      // 保真/覆盖是确定性校验，导入完立刻算，随事件发出去
      const flat = result.steps.filter((s) => s.command !== null && s.command !== '')
      const fidelity = checkFidelity(flat.map((s) => s.command!), material.text, params)
      const byIndex = new Map(flat.map((s, i) => [i, s.id]))

      // 原文里的坑：存成 personal 的坑（诊断/起草能检索到）；锚定到具体
      // 步骤的显示层级是 M9 的事
      for (const l of imported.lessons) {
        const stepId = l.stepIndex !== undefined ? byIndex.get(l.stepIndex) : undefined
        const stepTitle = stepId !== undefined ? result.steps.find((s) => s.id === stepId)?.title : undefined
        store.createLesson({
          anchorKind: 'free',
          condition: stepTitle !== undefined ? `步骤「${stepTitle}」` : null,
          symptom: l.symptom,
          fixMd: l.fix,
          authorId: currentUserId(),
          sourceTaskId: taskId,
          scope: 'personal',
        })
      }

      store.appendEvent({
        taskId,
        actorId: null,
        kind: 'replanned',
        payload: {
          version: result.runbook.version,
          by: 'qb',
          reason: '从素材整理',
          model: imported.model,
          dropped: imported.dropped,
          gaps: imported.gaps,
          fidelity: {
            verbatim: fidelity.items.filter((i) => i.verbatim).length,
            total: fidelity.items.length,
            rewritten: fidelity.items
              .filter((i) => !i.verbatim && !i.unverified)
              .map((i) => ({ stepId: byIndex.get(i.index) ?? null, closest: i.closest ?? null })),
            uncoveredCount: fidelity.uncovered.length,
          },
        },
      })

      ws.broadcast({ type: 'runbook.updated', taskId, version: result.runbook.version })
      return { version: result.runbook.version, gaps: imported.gaps }
    })

    sendJson(res, existing ? 200 : 202, { jobId: job.id, existing })
  })

  // ── 找底稿 ───────────────────────────────────────────────

  router.get('/tasks/suggest-bases', (_req, res, ctx) => {
    const q = ctx.query.get('q') ?? ''
    const tasks = store.searchTasks(q)
    const suggestions = tasks
      .map((t) => ({ task: t, latest: store.getLatestRunbook(t.id) }))
      .filter((x) => x.latest !== null)
      .map((x) => ({
        taskId: x.task.id,
        title: x.task.title,
        status: x.task.status,
        runbookId: x.latest!.runbook.id,
        version: x.latest!.runbook.version,
        updatedAt: x.latest!.runbook.createdAt,
      }))
    sendJson(res, 200, { suggestions })
  })

  // ── 以底稿为基础（模式 A 第一步）───────────────────────────

  router.post('/tasks/:id/based-on', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const body = (ctx.body ?? {}) as { runbookId?: string }
    if (typeof body.runbookId !== 'string') {
      sendJson(res, 400, { error: 'bad_request', message: '要给 runbookId' })
      return
    }

    try {
      const before = latestOf(taskId)
      if (before !== null) store.snapshotRunbook(before.runbook.id, '换底稿前', currentUserId())
      const copied = store.copyRunbook(body.runbookId, taskId, currentUserId())
      store.markTaskStarted(taskId, currentUserId())
      store.appendEvent({
        taskId,
        actorId: currentUserId(),
        kind: 'replanned',
        payload: { version: copied.runbook.version, reason: '以既有 runbook 为基础', baseRunbookId: body.runbookId },
      })
      ws.broadcast({ type: 'runbook.updated', taskId, version: copied.runbook.version })
      sendJson(res, 201, { runbook: copied.runbook, steps: copied.steps })
    } catch (e) {
      sendJson(res, 400, { error: 'copy_failed', message: errMessage(e) })
    }
  })

  // ── 差异提议（模式 A 第二步 / 情况变了）─────────────────────

  router.post('/tasks/:id/adapt', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const body = (ctx.body ?? {}) as { message?: string }
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: '要说明这次有什么不同' })
      return
    }
    const latest = latestOf(taskId)
    if (latest === null) {
      sendJson(res, 400, { error: 'no_runbook', message: '还没有 runbook，先导入或起草' })
      return
    }

    const { job, existing } = jobs.start('adapt', taskId, async (report) => {
      report('对照这次的说明找差异')
      return proposeAdapt(llm, prompts.persona, prompts.adapt, {
        message: body.message!,
        params: latest.runbook.params,
        steps: latest.steps,
        lessons: store.searchLessons(`${task.title} ${body.message}`, 8),
      })
    })
    sendJson(res, existing ? 200 : 202, { jobId: job.id, existing })
  })

  /** 应用差异：参数合并 + 命令就地改（每处一条 edit 事件），应用前留快照。 */
  router.post('/tasks/:id/adapt/apply', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = latestOf(taskId)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = AdaptApplyBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const body = parsed.data

    try {
      store.snapshotRunbook(latest.runbook.id, '应用差异前', currentUserId())

      // 参数：改值 → source mine；没有的新建
      const params: Param[] = latest.runbook.params.map((p) => ({ ...p }))
      const byName = new Map(params.map((p) => [p.name, p]))
      for (const c of body.paramChanges) {
        const existing = byName.get(c.name)
        if (existing !== undefined) {
          existing.value = c.to
          existing.source = 'mine'
        } else {
          const created: Param = { name: c.name, value: c.to, source: 'mine', secret: false }
          params.push(created)
          byName.set(c.name, created)
        }
      }
      for (const p of body.newParams) {
        if (!byName.has(p.name)) {
          const created: Param = {
            name: p.name,
            value: p.value,
            source: 'mine',
            secret: p.secret ?? false,
            ...(p.description !== undefined ? { description: p.description } : {}),
          }
          params.push(created)
          byName.set(p.name, created)
        }
      }
      store.updateRunbookParams(latest.runbook.id, params, latest.runbook.origin === 'copy' ? 'adapt' : undefined)

      // 命令：就地改，每处一条 edit 事件
      for (const e of body.stepEdits) {
        const step = store.getStep(e.stepId)
        if (step === null || step.runbookId !== latest.runbook.id) continue
        const { step: after } = store.updateStep(step.id, { command: e.command }, { expectedRev: step.rev, actorId: currentUserId() })
        store.appendEvent({
          taskId,
          stepId: step.id,
          actorId: currentUserId(),
          kind: 'edit',
          payload: { changes: [{ field: 'command', before: step.command, after: e.command }], source: 'adapt' },
        })
        void after
      }

      const summary = `应用差异：${body.paramChanges.length} 项参数、${body.stepEdits.length} 处命令${body.reason !== undefined ? `（${body.reason}）` : ''}`
      store.appendEvent({ taskId, actorId: currentUserId(), kind: 'replanned', payload: { reason: summary, by: 'user' } })
      changed(taskId)
      sendJson(res, 200, { ok: true, summary })
    } catch (e) {
      sendJson(res, 400, { error: 'apply_failed', message: errMessage(e) })
    }
  })

  // ── 参数 ─────────────────────────────────────────────────

  /** 覆盖参数表。值变了的标 source=mine（界面据此高亮"这次改过"）。 */
  router.patch('/tasks/:id/params', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = latestOf(taskId)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = z.array(ParamBody).min(0).safeParse((ctx.body as { params?: unknown } ?? {}).params)
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }

    const prev = new Map(latest.runbook.params.map((p) => [p.name, p]))
    const next: Param[] = parsed.data.map((p) => ({
      name: p.name,
      value: p.value,
      source: p.source ?? (prev.get(p.name)?.value !== p.value ? 'mine' : prev.get(p.name)?.source ?? 'mine'),
      secret: p.secret ?? prev.get(p.name)?.secret ?? false,
      ...(p.description !== undefined || prev.get(p.name)?.description !== undefined
        ? { description: p.description ?? prev.get(p.name)!.description }
        : {}),
    }))
    store.updateRunbookParams(latest.runbook.id, next)

    const changes = next
      .filter((p) => prev.get(p.name)?.value !== p.value)
      .map((p) => ({ name: p.name, before: prev.get(p.name)?.value ?? null, after: p.value }))
    if (changes.length > 0) {
      store.markTaskStarted(taskId, currentUserId())
      store.appendEvent({ taskId, actorId: currentUserId(), kind: 'edit', payload: { changes: [{ field: 'params', before: null, after: null }], paramChanges: changes } })
    }
    changed(taskId)
    sendJson(res, 200, { params: next })
  })

  /** 提取建议：渲染后的命令里重复出现的字面值。 */
  router.post('/tasks/:id/params/suggest', (_req, res, ctx) => {
    const latest = latestOf(ctx.params.id!)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const rendered = latest.steps
      .map((s) => (s.command !== null ? renderCommand(s.command, latest.runbook.params).text : ''))
      .filter((t) => t !== '')
    const known = new Set(latest.runbook.params.map((p) => p.value))
    const suggestions = literalSuggestions(rendered).filter((s) => !known.has(s.value))
    sendJson(res, 200, { suggestions })
  })

  /** 应用提取建议：字面值 → {{参数名}}，改到的步骤各记一条 edit 事件。 */
  router.post('/tasks/:id/params/apply-suggestions', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = latestOf(taskId)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const parsed = SuggestApplyBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }

    try {
      store.snapshotRunbook(latest.runbook.id, '参数化前', currentUserId())

      let touched = 0
      for (const s of latest.steps) {
        if (s.command === null || s.command === '') continue
        let next = s.command
        for (const item of parsed.data.items) {
          if (next.includes(item.value)) next = next.split(item.value).join(`{{${item.name}}}`)
        }
        if (next !== s.command) {
          const { step } = store.updateStep(s.id, { command: next }, { expectedRev: s.rev, actorId: currentUserId() })
          store.appendEvent({
            taskId,
            stepId: s.id,
            actorId: currentUserId(),
            kind: 'edit',
            payload: { changes: [{ field: 'command', before: s.command, after: next }], source: 'parametrize' },
          })
          touched++
          void step
        }
      }

      const params: Param[] = latest.runbook.params.map((p) => ({ ...p }))
      const byName = new Map(params.map((p) => [p.name, p]))
      for (const item of parsed.data.items) {
        if (!byName.has(item.name)) {
          const created: Param = { name: item.name, value: item.value, source: 'mine', secret: false }
          params.push(created)
          byName.set(item.name, created)
        }
      }
      store.updateRunbookParams(latest.runbook.id, params)

      store.appendEvent({
        taskId,
        actorId: currentUserId(),
        kind: 'edit',
        payload: { changes: [{ field: 'params', before: null, after: null }], parametrize: parsed.data.items, touchedSteps: touched },
      })
      changed(taskId)
      sendJson(res, 200, { touchedSteps: touched })
    } catch (e) {
      sendJson(res, 400, { error: 'apply_failed', message: errMessage(e) })
    }
  })

  // ── 终端分流（L0.5）───────────────────────────────────────

  /** 一次贴一大段终端输出：按提示符切分，按命令匹配回步骤，各自取证。 */
  router.post('/tasks/:id/transcript', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const latest = latestOf(taskId)
    if (latest === null) {
      sendJson(res, 404, { error: 'not_found', message: '还没有 runbook' })
      return
    }
    const body = (ctx.body ?? {}) as { text?: string }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: '终端记录是空的' })
      return
    }

    const blocks = splitTranscript(sanitizeText(body.text))
    if (blocks.length === 0) {
      sendJson(res, 400, { error: 'bad_request', message: '没认出任何命令——这段里没有提示符' })
      return
    }
    const matches = matchBlocks(blocks, latest.steps, latest.runbook.params)

    let matched = 0
    for (const m of matches) {
      if (m.stepId === null) continue
      const step = latest.steps.find((s) => s.id === m.stepId)!
      const block = blocks[m.blockIndex]!
      matched++

      const clean = redact(sanitizeText(block.output))
      const capped = tailCap(clean.text, 64 * 1024)
      store.addEvidence({ stepId: step.id, source: 'paste', text: capped.text, redacted: clean.hits.length > 0 })

      // 与手动粘贴同一套判定；exitCode 预期跳过（粘贴里没有退出码）
      let verdict: Verdict | null = null
      let reason = ''
      const expectation = step.expectation as Expectation | null
      if (expectation !== null && expectation.kind !== 'exitCode') {
        const check = checkExpectation(expectation, { exitCode: 0, stdout: block.output, stderr: '', timedOut: false })
        verdict = check.verdict
        reason = check.reason
      }
      const status: StepStatus = verdict === 'fail' ? 'failed' : verdict === 'pass' ? 'ok' : step.status
      if (status !== step.status) store.updateStepStatus(step.id, status, { endedAt: Date.now() })
      store.appendEvent({
        taskId,
        stepId: step.id,
        actorId: currentUserId(),
        kind: status === 'failed' ? 'step_failed' : 'step_ok',
        payload: { source: 'transcript', verdict, reason },
      })
      ws.broadcast({ type: 'step.status', stepId: step.id, status })
    }

    const unmatched = matches.filter((m) => m.stepId === null).map((m) => blocks[m.blockIndex]!.command)
    store.markTaskStarted(taskId, currentUserId())
    store.appendEvent({
      taskId,
      actorId: currentUserId(),
      kind: 'edit',
      payload: { changes: [], transcript: { matched, unmatchedCount: unmatched.length } },
    })
    changed(taskId)
    sendJson(res, 200, { matched, unmatched })
  })
}

/** 任务详情里的保真报告：导入/复制来的 runbook 每次取详情时现算（参数
 * 改了，逐字与否会跟着变）。 */
export function fidelityFor(store: Store, taskId: string): {
  items: Array<{ stepId: string; verbatim: boolean; unverified: boolean; closest: string | null }>
  uncoveredCount: number
  materialId: string | null
} | null {
  const latest = store.getLatestRunbook(taskId)
  if (latest === null || (latest.runbook.origin !== 'import' && latest.runbook.origin !== 'adapt' && latest.runbook.origin !== 'copy')) return null
  const materialMeta = store.latestMaterial(taskId)
  if (materialMeta === null) return null
  const material = store.getMaterial(materialMeta.id)
  if (material === null) return null

  const flat = latest.steps.filter((s) => s.command !== null && s.command !== '')
  const report = checkFidelity(flat.map((s) => s.command!), material.text, latest.runbook.params)
  return {
    items: report.items.map((i) => ({
      stepId: flat[i.index]?.id ?? '',
      verbatim: i.verbatim,
      unverified: i.unverified,
      closest: i.closest ?? null,
    })),
    uncoveredCount: report.uncovered.length,
    materialId: material.id,
  }
}

/** toParamName 重导出：路由层用它把建议名兜底成合法参数名。 */
export { toParamName }
