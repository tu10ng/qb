/**
 * runbook 的原地编辑：改内容、插入、移动、删除与撤销、跳过/标记失败。
 *
 * 每次改动记一条事件（改前/改后/谁）。人对计划的修正是最强的学习信号
 * （AGENTS.md §7），也是撤销与复盘的依据。改动后广播 runbook.changed，
 * 同一任务开着的其他标签页随之刷新。
 */

import { z } from 'zod'
import { Expectation, ReadinessProbe, StepKind, StepPatch, type StepStatus } from '@qb/core'
import { RevConflict, type Store } from '@qb/store'
import { errMessage, sendJson, type Router } from './router.ts'
import type { createWsHandler } from './ws.ts'

export interface EditDeps {
  store: Store
  ws: ReturnType<typeof createWsHandler>
  currentUserId: () => string
  /** 正在执行的步骤不能删除。 */
  isRunning: (stepId: string) => boolean
}

const PatchBody = StepPatch.extend({ rev: z.number().int().nonnegative() })

const NewStepBody = z.object({
  kind: StepKind,
  title: z.string().trim().min(1),
  whyMd: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  expectation: Expectation.nullable().optional(),
  probe: ReadinessProbe.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
})

const InsertBody = z.object({
  parentId: z.string().nullable(),
  afterId: z.string().nullable(),
  step: NewStepBody,
})

const MoveBody = z.object({
  rev: z.number().int().nonnegative(),
  parentId: z.string().nullable(),
  afterId: z.string().nullable(),
})

/** 人手动能设的状态。running 只能由执行产生。 */
const StatusBody = z.object({
  status: z.enum(['pending', 'ok', 'failed', 'skipped']),
  note: z.string().max(2000).optional(),
})

export function registerEditRoutes(router: Router, deps: EditDeps): void {
  const { store, ws, currentUserId } = deps

  const changed = (taskId: string, stepId: string | null): void => {
    ws.broadcast({ type: 'runbook.changed', taskId, stepId })
  }

  /** 改一步的内容。带 rev：别处先改了就 409 并带回最新内容。 */
  router.patch('/steps/:id', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const parsed = PatchBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const taskId = store.taskIdOfStep(stepId)
    if (taskId === null || store.getStep(stepId) === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在或已删除' })
      return
    }

    const { rev, ...patch } = parsed.data
    try {
      const { step, changes } = store.updateStep(stepId, patch, { expectedRev: rev, actorId: currentUserId() })
      if (changes.length > 0) {
        store.markTaskStarted(taskId, currentUserId())
        store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'edit', payload: { changes } })
        changed(taskId, stepId)
      }
      sendJson(res, 200, { step })
    } catch (e) {
      if (e instanceof RevConflict) {
        sendJson(res, 409, { error: 'conflict', message: e.message, step: e.current })
        return
      }
      sendJson(res, 400, { error: 'edit_failed', message: errMessage(e) })
    }
  })

  /** 在某个位置插入一步。afterId=null 表示放在该父节点下的最前面。 */
  router.post('/runbooks/:id/steps', (_req, res, ctx) => {
    const runbook = store.getRunbook(ctx.params.id!)
    if (runbook === null) {
      sendJson(res, 404, { error: 'not_found', message: 'runbook 不存在' })
      return
    }
    const parsed = InsertBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }

    try {
      const step = store.insertStep({
        runbookId: runbook.id,
        parentId: parsed.data.parentId,
        afterId: parsed.data.afterId,
        step: parsed.data.step,
        origin: 'human',
      })
      store.markTaskStarted(runbook.taskId, currentUserId())
      store.appendEvent({
        taskId: runbook.taskId,
        stepId: step.id,
        actorId: currentUserId(),
        kind: 'insert',
        payload: { title: step.title, parentId: step.parentId, afterId: parsed.data.afterId },
      })
      changed(runbook.taskId, step.id)
      sendJson(res, 201, { step })
    } catch (e) {
      sendJson(res, 400, { error: 'insert_failed', message: errMessage(e) })
    }
  })

  /** 移动：换父节点（进出章节）或同层重排。 */
  router.post('/steps/:id/move', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const parsed = MoveBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const taskId = store.taskIdOfStep(stepId)
    if (taskId === null || store.getStep(stepId) === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在或已删除' })
      return
    }

    try {
      const { step, from } = store.moveStep(
        stepId,
        { parentId: parsed.data.parentId, afterId: parsed.data.afterId },
        { expectedRev: parsed.data.rev },
      )
      store.appendEvent({
        taskId,
        stepId,
        actorId: currentUserId(),
        kind: 'reorder',
        payload: { from, to: { parentId: step.parentId, orderKey: step.orderKey } },
      })
      changed(taskId, stepId)
      sendJson(res, 200, { step })
    } catch (e) {
      if (e instanceof RevConflict) {
        sendJson(res, 409, { error: 'conflict', message: e.message, step: e.current })
        return
      }
      sendJson(res, 400, { error: 'move_failed', message: errMessage(e) })
    }
  })

  /** 删除（可撤销）：连同子步骤一起隐藏。 */
  router.delete('/steps/:id', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    const taskId = store.taskIdOfStep(stepId)
    if (step === null || taskId === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在或已删除' })
      return
    }
    // 查整棵子树，不只是这一步：删掉"子步骤正在跑"的章节，跑完后会把
    // 状态和证据写进已隐藏的行
    const runningChild = store.subtreeIds(stepId).find((id) => deps.isRunning(id))
    if (runningChild !== undefined) {
      sendJson(res, 409, { error: 'running', message: '这一步或它的子步骤正在执行，先取消再删' })
      return
    }

    const { ids } = store.deleteStep(stepId)
    store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'step_deleted', payload: { title: step.title, ids } })
    changed(taskId, stepId)
    sendJson(res, 200, { ids })
  })

  router.post('/steps/:id/restore', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId, { includeDeleted: true })
    const taskId = store.taskIdOfStep(stepId)
    if (step === null || taskId === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }

    const { ids } = store.restoreStep(stepId)
    if (ids.length > 0) {
      store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'step_restored', payload: { title: step.title, ids } })
      changed(taskId, stepId)
    }
    sendJson(res, 200, { ids })
  })

  /**
   * 人直接设状态：跳过、标记失败（带一句原因）、标记完成、重置。
   *
   * 相信用户：人的判断不被机器否决，也不追问理由——原因可选。
   */
  router.post('/steps/:id/status', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const parsed = StatusBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('；') })
      return
    }
    const step = store.getStep(stepId)
    const taskId = store.taskIdOfStep(stepId)
    if (step === null || taskId === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在或已删除' })
      return
    }
    if (deps.isRunning(stepId)) {
      sendJson(res, 409, { error: 'running', message: '这一步正在执行，先取消' })
      return
    }

    const status: StepStatus = parsed.data.status
    const note = parsed.data.note?.trim() ?? ''
    store.updateStepStatus(stepId, status, {
      ...(status === 'pending' ? { resetTimings: true } : { endedAt: Date.now() }),
      note: note === '' ? null : note,
    })
    store.markTaskStarted(taskId, currentUserId())

    const kind = status === 'skipped' ? 'step_skipped' : status === 'failed' ? 'step_failed' : status === 'ok' ? 'step_ok' : 'edit'
    store.appendEvent({
      taskId,
      stepId,
      actorId: currentUserId(),
      kind,
      payload: kind === 'edit' ? { changes: [{ field: 'status', before: step.status, after: status }] } : { source: 'manual', reason: note },
    })

    ws.broadcast({ type: 'step.status', stepId, status })
    changed(taskId, stepId)
    sendJson(res, 200, { stepId, status })
  })
}
