import { NeedsConfirmation, runStep, type StepRunHandle } from '../runner/run-step.ts'
import { Router, sendJson, errMessage } from './router.ts'
import type { createWsHandler } from './ws.ts'
import type { HostPort } from '../dsh/port.ts'
import type { Store } from '@qb/server'
import type { Expectation, StepStatus } from '@qb/core'

export interface ApiDeps {
  host: HostPort
  store: Store
  ws: ReturnType<typeof createWsHandler>
  mount: string
  /** 单人 dogfood 阶段的当前用户；多人阶段换成从令牌解析。 */
  currentUserId: () => string
}

const DEFAULT_TIMEOUT_MS = 120_000

export function buildApi(deps: ApiDeps): Router {
  const { host, store, ws, mount, currentUserId } = deps
  const router = new Router(`${mount}/api`)

  // 正在执行的步骤：用于取消、防重复启动
  const running = new Map<string, StepRunHandle>()

  router.get('/health', (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      service: 'qb-engine',
      host: host.info.host,
      port: host.info.port,
      wsClients: ws.clientCount,
      running: running.size,
    })
  })

  router.get('/me', (_req, res) => {
    const user = store.getUser(currentUserId())
    if (user === null) {
      sendJson(res, 500, { error: 'no_user', message: '当前用户不存在' })
      return
    }
    sendJson(res, 200, user)
  })

  // ── 任务 ───────────────────────────────────────────────────

  router.get('/tasks', (_req, res, ctx) => {
    const me = currentUserId()
    const scope = ctx.query.get('scope') ?? 'mine'
    const tasks =
      scope === 'delegated'
        ? store.listTasks({ initiatorId: me }).filter((t) => t.assigneeId !== me)
        : store.listTasks({ assigneeId: me })
    sendJson(res, 200, { tasks })
  })

  router.post('/tasks', (_req, res, ctx) => {
    const body = (ctx.body ?? {}) as {
      title?: string
      briefMd?: string
      assigneeId?: string
      expectedMinutes?: number
      dueAt?: number
      definitionOfDone?: string
    }

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: 'title 不能为空' })
      return
    }

    const task = store.createTask({
      title: body.title.trim(),
      initiatorId: currentUserId(),
      ...(body.briefMd !== undefined ? { briefMd: body.briefMd } : {}),
      ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
      ...(body.expectedMinutes !== undefined ? { expectedMinutes: body.expectedMinutes } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      ...(body.definitionOfDone !== undefined ? { definitionOfDone: body.definitionOfDone } : {}),
    })

    sendJson(res, 201, task)
  })

  router.get('/tasks/:id', (_req, res, ctx) => {
    const task = store.getTask(ctx.params.id!)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    sendJson(res, 200, task)
  })

  /** 任务详情：runbook + 步骤 + 事件，一次取全，省得前端串行请求。 */
  router.get('/tasks/:id/runbook', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const latest = store.getLatestRunbook(taskId)
    sendJson(res, 200, {
      task,
      runbook: latest?.runbook ?? null,
      steps: latest?.steps ?? [],
      events: store.listEvents(taskId),
    })
  })

  /**
   * 写入一个新版本的 runbook。
   *
   * QB 起草、用户编辑结构、重规划都走这里——每次都是新版本，
   * 旧版本连同事件保留，这是"为什么上次分解得不对"能被回答的前提。
   */
  router.post('/tasks/:id/runbook', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const body = (ctx.body ?? {}) as {
      steps?: unknown
      assumptions?: unknown
      sourceSkillId?: string | null
      sourceSkillVersion?: number | null
      reason?: string
    }

    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      sendJson(res, 400, { error: 'bad_request', message: 'steps 不能为空' })
      return
    }

    try {
      const result = store.createRunbook({
        taskId,
        createdBy: currentUserId(),
        steps: body.steps as Parameters<Store['createRunbook']>[0]['steps'],
        ...(Array.isArray(body.assumptions)
          ? { assumptions: body.assumptions as Parameters<Store['createRunbook']>[0]['assumptions'] }
          : {}),
        ...(body.sourceSkillId !== undefined ? { sourceSkillId: body.sourceSkillId } : {}),
        ...(body.sourceSkillVersion !== undefined
          ? { sourceSkillVersion: body.sourceSkillVersion }
          : {}),
      })

      // 版本 >1 意味着这是重规划，值得单独记一笔——它是最强的学习信号
      if (result.runbook.version > 1) {
        store.appendEvent({
          taskId,
          actorId: currentUserId(),
          kind: 'replanned',
          payload: { version: result.runbook.version, reason: body.reason ?? null },
        })
      }

      ws.broadcast({ type: 'runbook.updated', taskId, version: result.runbook.version })
      sendJson(res, 201, result)
    } catch (e) {
      sendJson(res, 400, { error: 'invalid_steps', message: errMessage(e) })
    }
  })

  router.get('/tasks/:id/versions', (_req, res, ctx) => {
    sendJson(res, 200, { versions: store.listRunbookVersions(ctx.params.id!) })
  })

  // ── 步骤执行 ───────────────────────────────────────────────

  /**
   * 执行一步。
   *
   * 立刻返回 202，输出经 WS 推送：长任务（起 vLLM 要几分钟）不该
   * 占着 HTTP 连接，用户切走再回来也能重新订阅。
   */
  router.post('/steps/:id/run', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const body = (ctx.body ?? {}) as { confirmed?: boolean; cwd?: string; env?: Record<string, string> }

    const step = store.getStep(stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found', message: '步骤不存在' })
      return
    }
    if (step.command === null || step.command.trim() === '') {
      sendJson(res, 400, { error: 'no_command', message: '这一步没有命令，不能运行' })
      return
    }
    if (running.has(stepId)) {
      sendJson(res, 409, { error: 'already_running', message: '这一步正在执行' })
      return
    }

    const taskId = store.taskIdOfStep(stepId)

    let handle: StepRunHandle
    try {
      handle = runStep(host, {
        stepId,
        command: step.command,
        expectation: step.expectation as Expectation | null,
        timeoutMs: step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.env !== undefined ? { env: body.env } : {}),
        ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
      })
    } catch (e) {
      if (e instanceof NeedsConfirmation) {
        // 409 而非 403：这不是拒绝，是"再点一下"。前端据此亮红框。
        sendJson(res, 409, {
          error: 'needs_confirmation',
          message: e.message,
          matched: e.matched,
          command: e.command,
        })
        return
      }
      sendJson(res, 500, { error: 'internal', message: errMessage(e) })
      return
    }

    const startedAt = Date.now()
    running.set(stepId, handle)
    store.updateStepStatus(stepId, 'running', { startedAt })
    if (taskId !== null) {
      store.markTaskStarted(taskId, currentUserId())
      store.appendEvent({ taskId, stepId, actorId: currentUserId(), kind: 'step_run', payload: {} })
    }
    ws.broadcast({ type: 'step.status', stepId, status: 'running' })

    handle.onChunk((chunk) => {
      ws.broadcast({ type: 'step.output', stepId, text: chunk.text, lossy: chunk.lossy })
    })

    void handle.outcome
      .then((outcome) => {
        running.delete(stepId)

        const status: StepStatus = outcome.verdict === 'pass' ? 'ok' : outcome.verdict === 'fail' ? 'failed' : 'running'
        const endedAt = Date.now()
        // unclear 时保持 running：等模型判定或用户手动裁定，
        // 不能擅自当成成功或失败。
        if (outcome.verdict !== 'unclear') {
          store.updateStepStatus(stepId, status, { endedAt, actualMs: outcome.result.durationMs })
        }

        if (taskId !== null) {
          store.appendEvent({
            taskId,
            stepId,
            actorId: currentUserId(),
            kind: outcome.result.timedOut ? 'step_timeout' : outcome.verdict === 'pass' ? 'step_ok' : 'step_failed',
            payload: {
              verdict: outcome.verdict,
              reason: outcome.reason,
              exitCode: outcome.result.exitCode,
              durationMs: outcome.result.durationMs,
            },
          })
        }

        ws.broadcast({
          type: 'step.done',
          stepId,
          verdict: outcome.verdict,
          reason: outcome.reason,
          exitCode: outcome.result.exitCode,
          timedOut: outcome.result.timedOut,
          durationMs: outcome.result.durationMs,
          danger: outcome.danger,
          redactionHits: outcome.redactionHits,
        })
      })
      .catch((e: unknown) => {
        running.delete(stepId)
        store.updateStepStatus(stepId, 'failed', { endedAt: Date.now() })
        ws.broadcast({ type: 'step.error', stepId, message: errMessage(e) })
      })

    sendJson(res, 202, { stepId, status: 'running' })
  })

  router.post('/steps/:id/cancel', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const handle = running.get(stepId)
    if (handle === undefined) {
      sendJson(res, 404, { error: 'not_running', message: '这一步没有在执行' })
      return
    }
    sendJson(res, 200, { stepId, killed: handle.cancel() })
  })

  return router
}
