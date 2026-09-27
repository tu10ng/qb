/**
 * M7 路由：从已有的开始 + 参数。
 *
 * 素材 → 忠实导入（模式 B）；底稿 → 复制（模式 A 第一步）→ 差异提议 →
 * 逐项接受；参数的就地修改与提取建议；一段终端输出分流回各步（L0.5）。
 * 确定性的校验（保真/覆盖/匹配）都在这里跑，不指望模型自觉。
 */

import { z } from 'zod'
import { checkExpectation, literalSuggestions, matchBlocks, redact, renderCommand, sanitizeText, splitTranscript, tailCap, checkFidelity, type Expectation, type Param, type StepStatus, type Verdict } from '@qb/core'
import type { Store } from '@qb/store'
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
  text: z.string().min(1, '素材内容是空的').max(200_000, '素材太长（上限 20 万字符）——拆成几段分次贴'),
  filename: z.string().optional(),
})

const AdaptApplyBody = z.object({
  paramChanges: z.array(z.object({ name: z.string(), to: z.string() })).default([]),
  newParams: z.array(ParamBody).default([]),
  stepEdits: z.array(z.object({ stepId: z.string(), command: z.string().min(1) })).default([]),
  reason: z.string().optional(),
  /** 界面看到差异时的 runbook 版本：期间被别的标签页换过就拒绝。 */
  expectedVersion: z.number().int().positive().optional(),
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

      // 落库整体一个事务：快照、runbook、坑、事件要么全成要么全无
      const result = store.inTransaction(() => {
        const before = latestOf(taskId)
        if (before !== null) store.snapshotRunbook(before.runbook.id, '导入素材前', currentUserId())

        const params: Param[] = imported.params.map((p) => ({
          name: p.name,
          value: p.value,
          source: 'origin',
          secret: false,
          ...(p.description !== undefined ? { description: p.description } : {}),
        }))

        const created = store.createRunbook({
          taskId,
          createdBy: currentUserId(),
          origin: 'import',
          params,
          materialId: material.id,
          steps: imported.steps as Parameters<Store['createRunbook']>[0]['steps'],
        })

        // 保真/覆盖是确定性校验，导入完立刻算，随事件发出去
        const flat = created.steps.filter((s) => s.command !== null && s.command !== '')
        const fidelity = checkFidelity(flat.map((s) => s.command!), material.text, params)
        const fidelityStep = new Map(flat.map((s, i) => [i, s.id]))
        // 坑的 stepIndex 是模型按它自己的步骤列表（含无命令的步骤）编的号，
        // 映射要用同一套下标：文档序、排除章节标题
        const lessonStep = new Map(
          created.steps.filter((s) => !(s.kind === 'note' && s.parentId === null)).map((s, i) => [i, s.id]),
        )

        // 原文里的坑：锚到步骤血缘（同血缘的复制品都看得见，M9）；
        // 锚不上的自由挂载，条件里带步骤名。同症状的不重复插（重复导入时）。
        for (const l of imported.lessons) {
          if (store.hasLesson(taskId, l.symptom)) continue
          const stepId = l.stepIndex !== undefined ? lessonStep.get(l.stepIndex) : undefined
          const stepObj = stepId !== undefined ? created.steps.find((s) => s.id === stepId) : undefined
          const stepTitle = stepObj?.title
          store.createLesson({
            anchorKind: stepObj?.lineageKey != null ? 'step_lineage' : 'free',
            anchorRef: stepObj?.lineageKey ?? null,
            condition: stepObj?.lineageKey == null && stepTitle !== undefined ? `步骤「${stepTitle}」` : null,
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
            version: created.runbook.version,
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
                .map((i) => ({ stepId: fidelityStep.get(i.index) ?? null, closest: i.closest ?? null })),
              uncoveredCount: fidelity.uncovered.length,
            },
          },
        })
        return created
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

    // 期间 runbook 换过版本（别的标签页导入/换底稿）就拒绝：参数会写进
    // 已非最新的版本，命令改动会被静默丢弃
    if (body.expectedVersion !== undefined && body.expectedVersion !== latest.runbook.version) {
      sendJson(res, 409, { error: 'version_conflict', message: 'runbook 已更新（别的页面导入或换了底稿），请刷新后重试' })
      return
    }

    try {
      const summary = store.inTransaction(() => {
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
          store.updateStep(step.id, { command: e.command }, { expectedRev: step.rev, actorId: currentUserId() })
          store.appendEvent({
            taskId,
            stepId: step.id,
            actorId: currentUserId(),
            kind: 'edit',
            payload: { changes: [{ field: 'command', before: step.command, after: e.command }], source: 'adapt' },
          })
        }

        const summary = `应用差异：${body.paramChanges.length} 项参数、${body.stepEdits.length} 处命令${body.reason !== undefined ? `（${body.reason}）` : ''}`
        store.appendEvent({ taskId, actorId: currentUserId(), kind: 'replanned', payload: { reason: summary, by: 'user' } })
        // "情况变了"的原因 → 复盘时的沉淀候选（M9 捕获时机 4）
        if (body.reason !== undefined && body.reason !== '') {
          store.createLessonOffer({
            taskId,
            kind: 'situation',
            dedupKey: `sit:v${latest.runbook.version}:${body.reason}`,
            payload: { reason: body.reason },
          })
        }
        return summary
      })
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
    const next: Param[] = parsed.data.map((p) => {
      const before = prev.get(p.name)
      // 值变了的参数一律标 mine（界面据此高亮"这次改过"），不管客户端
      // 传了什么 source——面板发的是完整对象，会带着旧 source 回来
      const changed = before === undefined || before.value !== p.value
      return {
        name: p.name,
        value: p.value,
        source: changed ? ('mine' as const) : ((p.source ?? before?.source ?? 'mine') as Param['source']),
        secret: p.secret ?? before?.secret ?? false,
        ...(p.description !== undefined || before?.description !== undefined
          ? { description: p.description ?? before!.description }
          : {}),
      }
    })
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
      const applied = store.inTransaction((): { touchedSteps: number; items: Array<{ value: string; name: string }> } => {
        store.snapshotRunbook(latest.runbook.id, '参数化前', currentUserId())

        const params: Param[] = latest.runbook.params.map((p) => ({ ...p }))
        const byName = new Map(params.map((p) => [p.name, p]))
        // 同名参数已存在且值不同时换名（NAME_2、NAME_3…）：直接沿用旧名
        // 会让字面值悄悄渲染成旧参数的值
        const finalName = new Map<string, string>()
        for (const item of parsed.data.items) {
          let name = item.name
          const existing = byName.get(name)
          if (existing !== undefined && existing.value !== item.value) {
            // 同名参数已存在但值不同（如 PORT_8080 已是 9090）：换名
            // NAME_2、NAME_3…，直到不撞或撞到同值（同值直接复用）
            let resolved = ''
            for (let i = 2; i < 100; i++) {
              const cand = `${item.name}_${i}`
              const candParam = byName.get(cand)
              if (candParam === undefined || candParam.value === item.value) {
                resolved = cand
                break
              }
            }
            if (resolved === '') continue
            name = resolved
          }
          if (!byName.has(name)) {
            const created: Param = { name, value: item.value, source: 'mine', secret: false }
            params.push(created)
            byName.set(name, created)
          }
          finalName.set(item.value, name)
        }

        let touched = 0
        for (const s of latest.steps) {
          if (s.command === null || s.command === '') continue
          let next = s.command
          for (const item of parsed.data.items) {
            const name = finalName.get(item.value) ?? item.name
            if (next.includes(item.value)) next = next.split(item.value).join(`{{${name}}}`)
          }
          if (next !== s.command) {
            store.updateStep(s.id, { command: next }, { expectedRev: s.rev, actorId: currentUserId() })
            store.appendEvent({
              taskId,
              stepId: s.id,
              actorId: currentUserId(),
              kind: 'edit',
              payload: { changes: [{ field: 'command', before: s.command, after: next }], source: 'parametrize' },
            })
            touched++
          }
        }

        store.updateRunbookParams(latest.runbook.id, params)
        store.appendEvent({
          taskId,
          actorId: currentUserId(),
          kind: 'edit',
          payload: { changes: [{ field: 'params', before: null, after: null }], parametrize: [...finalName.entries()].map(([value, name]) => ({ value, name })), touchedSteps: touched },
        })
        return { touchedSteps: touched, items: [...finalName.entries()].map(([value, name]) => ({ value, name })) }
      })
      void applied
      changed(taskId)
      sendJson(res, 200, applied)
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

/** 任务详情里的保真报告：导入来的 runbook 每次取详情时现算（参数
 * 改了，逐字与否会跟着变）。copy/adapt 来源不参与——它们的命令来自
 * 底稿，跟这份任务的素材没有逐字关系，比了只会误报"改写过"。 */
export function fidelityFor(store: Store, taskId: string): {
  items: Array<{ stepId: string; verbatim: boolean; unverified: boolean; closest: string | null }>
  uncoveredCount: number
  materialId: string | null
} | null {
  const latest = store.getLatestRunbook(taskId)
  if (latest === null || latest.runbook.origin !== 'import') return null
  // 对着导入时的那份素材比（runbook 记了 materialId）；老数据没记时
  // 退化用任务最近一份素材
  const materialId = latest.runbook.materialId ?? store.latestMaterial(taskId)?.id ?? null
  if (materialId === null) return null
  const material = store.getMaterial(materialId)
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
