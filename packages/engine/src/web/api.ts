import { z } from 'zod'
import { NeedsConfirmation, runStep, type StepRunHandle } from '../runner/run-step.ts'
import { draftRunbook, partialSteps } from '../agent/draft.ts'
import { diagnoseFailure } from '../agent/diagnose.ts'
import type { Llm } from '../llm/port.ts'
import type { LlmSettings } from '../settings/llm-settings.ts'
import { Router, sendJson, errMessage } from './router.ts'
import { Jobs } from './jobs.ts'
import { registerEditRoutes } from './api-edit.ts'
import { registerSettingsRoutes } from './api-settings.ts'
import { fidelityFor, registerM7Routes } from './api-m7.ts'
import { registerTeamRoutes } from './api-team.ts'
import { AttachmentError, type Attachments } from './attachments.ts'
import type { LocalGuard } from './local-guard.ts'
import type { createWsHandler } from './ws.ts'
import type { HostPort } from '../dsh/port.ts'
import type { Store } from '@qb/store'
import type { Step, StepStatus, Verdict } from '@qb/core'
import { checkExpectation, redact, renderCommand, sanitizeText, tailCap, Expectation, ReadinessProbe, StepKind } from '@qb/core'

/** 落库的证据文本上限。报错在尾部，截前面；整份详情接口扛不住几十 MB 的日志。 */
const EVIDENCE_MAX_CHARS = 64 * 1024

export interface ApiDeps {
  host: HostPort
  store: Store
  ws: ReturnType<typeof createWsHandler>
  mount: string
  /** 单人 dogfood 阶段的当前用户；多人阶段换成从令牌解析。 */
  currentUserId: () => string
  /** QB 的提示词资产。 */
  prompts: { persona: string; draft: string; diagnose: string; import: string; adapt: string }
  llm: Llm
  settings: LlmSettings
  attachments: Attachments
  guard: LocalGuard
  team: { settings: import('../sync/sync.ts').TeamSettings; sync: import('../sync/sync.ts').Sync }
}

/** 整份替换接口的输入校验。之前直接 as 断言，畸形的 expectation 能入库。 */
interface StepInputT {
  kind: StepKind
  title: string
  whyMd?: string | null
  whySource?: string | null
  command?: string | null
  envId?: string | null
  expectation?: z.infer<typeof Expectation> | null
  probe?: z.infer<typeof ReadinessProbe> | null
  timeoutMs?: number | null
  expectedMinutes?: number | null
  origin?: 'human' | 'import' | 'base' | 'qb'
  lineageKey?: string
  sourceRef?: string | null
  children?: StepInputT[]
}

// 递归 schema 要显式标注类型，否则 TS 推不出自引用
const StepInput: z.ZodType<StepInputT> = z.object({
  kind: StepKind,
  title: z.string().min(1),
  whyMd: z.string().nullable().optional(),
  whySource: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  envId: z.string().nullable().optional(),
  expectation: Expectation.nullable().optional(),
  probe: ReadinessProbe.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
  origin: z.enum(['human', 'import', 'base', 'qb']).optional(),
  lineageKey: z.string().optional(),
  sourceRef: z.string().nullable().optional(),
  children: z.array(z.lazy(() => StepInput)).optional(),
})

const RunbookBody = z.object({
  steps: z.array(StepInput).min(1),
  assumptions: z
    .array(z.object({ key: z.string(), value: z.string(), editedByUser: z.boolean().default(false) }))
    .optional(),
  sourceSkillId: z.string().nullable().optional(),
  sourceSkillVersion: z.number().int().positive().nullable().optional(),
  reason: z.string().optional(),
})

const DEFAULT_TIMEOUT_MS = 120_000

/** 草稿部分结果的推送间隔：够跟手，又不至于淹掉 WS。 */
const PARTIAL_PUSH_MS = 250

export function buildApi(deps: ApiDeps): Router {
  const { host, store, ws, mount, currentUserId, prompts, llm, settings, attachments } = deps
  const router = new Router(`${mount}/api`, (req) => deps.guard.http(req))

  // 正在执行的步骤：用于取消、防重复启动
  const running = new Map<string, StepRunHandle>()

  // 后台任务（起草、诊断、看图、测试连接）：模型调用慢且耗时不可预测，不占 HTTP 连接
  const jobs = new Jobs({
    onUpdate: (job) => ws.broadcast({ type: 'job.update', job }),
  })

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
      initiatorName?: string
      expectedMinutes?: number
      dueAt?: number
      definitionOfDone?: string
    }

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: 'title 不能为空' })
      return
    }

    // 谁派的活：同事在 IM 里派的，记录下来——他在团队服务那边就能
    // 看到这个任务的全部进度与告警（任务=契约：发起人 → 执行者）
    const initiatorId =
      typeof body.initiatorName === 'string' && body.initiatorName.trim() !== ''
        ? store.ensureUser(body.initiatorName.trim()).id
        : currentUserId()

    const task = store.createTask({
      title: body.title.trim(),
      initiatorId,
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
      // 历史输出按步骤分组带上：刷新页面后还能看到上次跑出了什么
      evidence: latest === null ? {} : store.evidenceByRunbook(latest.runbook.id),
      // 进行中的后台任务：刷新后能接回"QB 正在起草/看截图"
      jobs: [taskId, ...(latest?.steps ?? []).map((s) => s.id)].flatMap((id) => jobs.activeFor(id)),
      // M7：导入来的 runbook 带保真报告与素材指针（贴了素材的任务才能"从素材整理"）
      fidelity: fidelityFor(store, taskId),
      material: store.latestMaterial(taskId),
    })
  })

  /**
   * 整份替换：写入一个新版本的 runbook。
   *
   * 只用于"推倒重来"（重新起草）和外部导入。日常编辑走 PATCH /steps/:id
   * 等原地修改的接口，不再每改一次就新建一个版本。
   * 替换前给当前版本留快照：复盘"上次为什么那样分解"、M7 的原地差异
   * 应用都以它为底。
   */
  router.post('/tasks/:id/runbook', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const parsed = RunbookBody.safeParse(ctx.body ?? {})
    if (!parsed.success) {
      sendJson(res, 400, { error: 'bad_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') })
      return
    }
    const body = parsed.data

    try {
      const latest = store.getLatestRunbook(taskId)
      if (latest !== null) store.snapshotRunbook(latest.runbook.id, body.reason ?? '整份替换前', currentUserId())

      const result = store.createRunbook({
        taskId,
        createdBy: currentUserId(),
        steps: body.steps,
        ...(body.assumptions !== undefined ? { assumptions: body.assumptions } : {}),
        ...(body.sourceSkillId !== undefined ? { sourceSkillId: body.sourceSkillId } : {}),
        ...(body.sourceSkillVersion !== undefined ? { sourceSkillVersion: body.sourceSkillVersion } : {}),
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

  /**
   * 让 QB 空白起草（兜底路径，整份标为 QB 写的）。
   *
   * 立刻返回任务 id，起草在后台跑。步骤边生成边经 WS 推送（job.partial），
   * 首步通常 2–5 秒就出现，不让用户对着转圈干等。
   */
  router.post('/tasks/:id/draft', (_req, res, ctx) => {
    const taskId = ctx.params.id!
    const task = store.getTask(taskId)
    if (task === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const { job, existing } = jobs.start('draft', taskId, async (report) => {
      let lastPush = 0
      // 重新起草前先留快照：旧版本的步骤连同状态是"上次是怎么分解的"的唯一记录
      const before = store.getLatestRunbook(taskId)
      if (before !== null) store.snapshotRunbook(before.runbook.id, 'QB 重新起草前', currentUserId())

      const draft = await draftRunbook(
        llm,
        prompts.persona,
        prompts.draft,
        {
          task,
          environments: store.listEnvironments(),
          skills: store.listSkills(),
          lessons: store.searchLessons(`${task.title} ${task.briefMd}`, 12),
        },
        {
          onPartial: (partial) => {
            const steps = partialSteps(partial)
            report(steps.length === 0 ? '开始写了' : `正在写第 ${steps.length} 步`)
            const now = Date.now()
            if (now - lastPush >= PARTIAL_PUSH_MS) {
              lastPush = now
              ws.broadcast({ type: 'job.partial', kind: 'draft', subjectId: taskId, steps })
            }
          },
        },
      )

      const result = store.createRunbook({
        taskId,
        createdBy: currentUserId(),
        origin: 'draft',
        assumptions: draft.assumptions,
        steps: draft.steps as Parameters<Store['createRunbook']>[0]['steps'],
      })

      store.appendEvent({
        taskId,
        actorId: null,
        kind: 'replanned',
        payload: {
          version: result.runbook.version,
          by: 'qb',
          model: draft.model,
          reason: result.runbook.version === 1 ? '起草' : '重新起草',
          // 丢弃数：宽容校验会静默丢掉不合格式的步骤，用户得知道少了几个
          dropped: draft.dropped,
        },
      })

      ws.broadcast({ type: 'runbook.updated', taskId, version: result.runbook.version })
      return { version: result.runbook.version }
    })

    sendJson(res, existing ? 200 : 202, { jobId: job.id, status: job.status, existing })
  })

  router.get('/jobs/:id', (_req, res, ctx) => {
    const job = jobs.get(ctx.params.id!)
    if (job === null) {
      sendJson(res, 404, { error: 'not_found', message: '任务不存在或已过期' })
      return
    }
    sendJson(res, 200, job)
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

    // 命令是模板：先按当前参数表渲染。缺值的参数宁可拒绝运行，
    // 也不能把 {{DECODE_HOST}} 原样发给 shell——写错了名字的（未声明）
    // 同样要拦。
    const runbook = taskId === null ? null : store.getLatestRunbook(taskId)
    const rendered = renderCommand(step.command, runbook?.runbook.params ?? [])
    const blocked = [...rendered.missing, ...rendered.undeclared]
    if (blocked.length > 0) {
      sendJson(res, 400, {
        error: 'missing_params',
        message: `${rendered.undeclared.length > 0 ? '未声明的参数' : '缺参数'}：${blocked.join('、')}`,
        missing: blocked,
      })
      return
    }

    let handle: StepRunHandle
    try {
      handle = runStep(host, {
        stepId,
        command: rendered.text,
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

        // 输出落库（脱敏 + 截尾后的版本）。不存的话刷新页面就看不到了，
        // 而复盘恰恰需要"当时到底输出了什么"。
        const capped = tailCap(joinOutput(outcome.redactedStdout, outcome.redactedStderr), EVIDENCE_MAX_CHARS)
        store.addEvidence({
          stepId,
          source: 'auto',
          text: capped.text,
          exitCode: outcome.result.exitCode,
          timedOut: outcome.result.timedOut,
          durationMs: outcome.result.durationMs,
          redacted: outcome.redactionHits.length > 0,
        })

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

  /**
   * 手动提交证据：用户自己跑完命令，把输出或截图贴回来。
   *
   * 这是"相信用户不当保姆"的落点——QB 不强求你用它的运行按钮。
   * 贴回来的文本同样过脱敏并判定预期；截图存盘，有能看图的模型且这步
   * 有预期时，交给 QB 在后台看一眼。
   */
  router.post('/steps/:id/evidence', async (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const body = (ctx.body ?? {}) as {
      text?: string
      imageBase64?: string
      mediaType?: string
      markDone?: boolean
    }

    const hasText = typeof body.text === 'string' && body.text.trim() !== ''
    const hasImage = typeof body.imageBase64 === 'string' && body.imageBase64 !== ''
    if (!hasText && !hasImage && body.markDone !== true) {
      sendJson(res, 400, { error: 'bad_request', message: '没有内容' })
      return
    }

    // 先存图：格式或大小不对要在写任何东西之前就拒绝
    let imageName: string | null = null
    if (hasImage) {
      try {
        imageName = await attachments.saveImage(body.imageBase64!, body.mediaType ?? 'image/png')
      } catch (e) {
        sendJson(res, e instanceof AttachmentError ? 400 : 500, { error: 'bad_image', message: errMessage(e) })
        return
      }
    }

    const taskId = store.taskIdOfStep(stepId)
    let verdict: Verdict | null = null
    let reason = ''

    if (hasText) {
      const clean = redact(sanitizeText(body.text!))
      const capped = tailCap(clean.text, EVIDENCE_MAX_CHARS)
      store.addEvidence({
        stepId,
        source: 'paste',
        text: capped.text,
        redacted: clean.hits.length > 0,
      })

      // 用户贴回来的输出同样要判定——他自己跑的和 QB 跑的一视同仁。
      // 但没有退出码：手动粘贴时那个信息本就不存在，不该因此判 unclear。
      // 依赖退出码的预期（kind: exitCode）在贴文本时干脆不判——硬按
      // 退出码 0 判，会让"预期退出码非 0"的检查步一贴输出就误报失败，
      // 这种步骤由用户自己点"完成"或"失败"。
      const expectation = step.expectation as Expectation | null
      if (expectation !== null && expectation.kind !== 'exitCode') {
        const check = checkExpectation(expectation, {
          // 人工提供的输出没有退出码。给 0 表示"不是异常终止"。
          exitCode: 0,
          stdout: body.text!,
          stderr: '',
          timedOut: false,
        })
        verdict = check.verdict
        reason = check.reason
      }
    }

    let judging = false
    if (imageName !== null) {
      const evidence = store.addEvidence({ stepId, source: 'image', imagePath: imageName })
      // 能看图、这步有预期、且文本没有给出结论（没判或判 unclear）时，才劳烦模型
      if (
        (verdict === null || verdict === 'unclear') &&
        body.markDone !== true &&
        step.expectation !== null &&
        llm.status('vision').ok
      ) {
        judging = true
        startImageJudge(step, evidence.id, imageName, taskId)
      }
    }

    // 状态推导：用户点"完成"最优先——人的判断不被机器否决。
    // 其次看预期判定。都没有时，贴了证据本身就说明这步做过了；
    // 正在看截图的，等看完再定。
    const status: StepStatus =
      body.markDone === true
        ? 'ok'
        : verdict === 'fail'
          ? 'failed'
          : verdict === 'pass'
            ? 'ok'
            : judging
              ? step.status
              : hasText || imageName !== null
                ? 'ok'
                : step.status

    if (status !== step.status) {
      store.updateStepStatus(stepId, status, { endedAt: Date.now() })
    }

    if (taskId !== null) {
      store.markTaskStarted(taskId, currentUserId())
      if (!judging || status !== step.status) {
        store.appendEvent({
          taskId,
          stepId,
          actorId: currentUserId(),
          kind: status === 'failed' ? 'step_failed' : 'step_ok',
          payload: { source: imageName !== null && !hasText ? 'image' : 'manual', verdict, reason },
        })
      }
      ws.broadcast({ type: 'runbook.changed', taskId, stepId })
    }

    ws.broadcast({ type: 'step.status', stepId, status })
    sendJson(res, 201, { stepId, status, verdict, reason, judging })
  })

  /** 截图文件。文件名由我们生成并按白名单校验，不接受任意路径。 */
  router.get('/evidence/:id/image', async (_req, res, ctx) => {
    const evidence = store.getEvidence(ctx.params.id!)
    const file = evidence?.imagePath != null ? await attachments.read(evidence.imagePath) : null
    if (file === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    res.writeHead(200, {
      'content-type': file.mediaType,
      'content-length': file.data.length,
      // 内容寻址，文件名即哈希，可以放心长缓存
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(file.data)
  })

  /**
   * 后台看截图：判定这一步达没达到预期，并把读到的内容记下来。
   * 排队执行：QB 还在看上一张时又贴一张，两张都要被看。
   */
  function startImageJudge(step: Step, evidenceId: string, imageName: string, taskId: string | null): void {
    jobs.start(
      'judge',
      step.id,
      async (report) => {
        report('QB 在看截图')
        const image = await attachments.read(imageName)
        if (image === null) throw new Error('截图文件不见了')

        const result = await llm.structured({
          purpose: 'vision',
          name: 'judgement',
          system:
            '你是 QB。用户执行完一步后贴回了截图。只依据图里看得到的内容，判断这一步是否达到了预期。看不出来就说看不出来，不要猜。',
          prompt: [
            `这一步：${step.title}`,
            step.command !== null ? `命令：${step.command}` : '',
            `预期：${describeExpectation(step.expectation as Expectation)}`,
          ]
            .filter(Boolean)
            .join('\n'),
          images: [{ data: image.data, mediaType: image.mediaType }],
          schema: JudgeSchema,
        })

        const { verdict, reason, seen } = result.output
        if (seen.trim() !== '') store.setEvidenceText(evidenceId, `QB 看到：${seen.trim()}`)

        // 人的判断不被机器否决：看图期间用户若已动手（完成/跳过/失败/
        // 又跑起来了），只把 QB 看到的记下来，不改状态
        const current = store.getStep(step.id)
        const applied = current !== null && verdict !== 'unclear' && current.status === 'pending'
        if (applied) {
          store.updateStepStatus(step.id, verdict === 'pass' ? 'ok' : 'failed', { endedAt: Date.now() })
          ws.broadcast({ type: 'step.status', stepId: step.id, status: verdict === 'pass' ? 'ok' : 'failed' })
        }
        if (taskId !== null) {
          store.appendEvent({
            taskId,
            stepId: step.id,
            actorId: null,
            kind: verdict === 'fail' ? 'step_failed' : 'step_ok',
            payload: { source: 'image', by: 'qb', verdict, reason, applied, model: result.model },
          })
          ws.broadcast({ type: 'runbook.changed', taskId, stepId: step.id })
        }
        return { verdict, reason, seen }
      },
      { queue: true },
    )
  }

  /**
   * 让 QB 诊断一步的失败。
   *
   * 先检索坑（本地 FTS，零成本），再交给模型判断哪条真的匹配。
   * 团队踩过的坑比模型的推测可信，所以检索在前。有截图时一并交给
   * 能看图的档案——报错可能只在图里。
   */
  router.post('/steps/:id/diagnose', async (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const step = store.getStep(stepId)
    if (step === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const evidence = store.listEvidence(stepId)
    const lastText = [...evidence].reverse().find((e) => e.text !== null && e.imagePath === null) ?? null
    const lastImage = [...evidence].reverse().find((e) => e.imagePath !== null) ?? null
    if (lastText === null && lastImage === null) {
      sendJson(res, 400, {
        error: 'no_evidence',
        message: '这一步还没有执行记录，没什么可诊断的',
      })
      return
    }

    // 检索关键词：命令 + 输出尾部。报错通常在尾部，
    // 前面的进度输出会污染检索。
    const output = lastText?.text ?? lastImage?.text ?? ''
    const query = [step.title, step.command ?? '', output.slice(-800)].join(' ')

    const image =
      lastImage !== null && llm.status('vision').ok ? await attachments.read(lastImage.imagePath!) : null

    try {
      const diagnosis = await diagnoseFailure(llm, prompts.persona, prompts.diagnose, {
        step,
        outcome: {
          exitCode: lastText?.exitCode ?? null,
          timedOut: lastText?.timedOut ?? false,
          durationMs: lastText?.durationMs ?? 0,
          output,
          verdict: step.status === 'failed' ? 'fail' : step.status,
          reason: step.status === 'failed' ? '与预期不符' : '',
        },
        lessons: store.searchLessons(query, 8),
        environmentNote: renderEnvNote(store),
        ...(image !== null ? { image: { data: image.data, mediaType: image.mediaType } } : {}),
      })

      const taskId = store.taskIdOfStep(stepId)
      if (taskId !== null) {
        store.appendEvent({
          taskId,
          stepId,
          actorId: null,
          kind: 'step_failed',
          payload: {
            by: 'qb',
            diagnosis: diagnosis.summary,
            fromLessonId: diagnosis.fromLessonId,
            model: diagnosis.model,
          },
        })
      }

      sendJson(res, 200, diagnosis)
    } catch (e) {
      sendJson(res, 502, { error: 'diagnose_failed', message: errMessage(e) })
    }
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

  registerEditRoutes(router, { store, ws, currentUserId, isRunning: (id) => running.has(id) })
  registerSettingsRoutes(router, { settings, llm, jobs })
  registerM7Routes(router, { store, ws, jobs, llm, currentUserId, prompts })
  registerTeamRoutes(router, { store, team: deps.team.settings, sync: deps.team.sync, currentUserId })

  return router
}

const JudgeSchema = z.object({
  seen: z.string().describe('图里与这一步相关的关键内容，一两句话；有报错就照抄报错').catch(''),
  verdict: z
    .enum(['pass', 'fail', 'unclear'])
    .describe('pass=图里能看出达到了预期；fail=明显没达到（比如有报错）；unclear=看不出来')
    .catch('unclear'),
  reason: z.string().describe('一句话理由').catch(''),
})

function describeExpectation(e: Expectation | null): string {
  if (e === null) return '（没有写明）'
  switch (e.kind) {
    case 'exitCode':
      return `退出码 ${e.code}`
    case 'contains':
      return `输出包含 "${e.text}"`
    case 'notContains':
      return `输出不含 "${e.text}"`
    case 'regex':
      return `输出匹配 /${e.pattern}/`
    case 'manual':
      return e.description
  }
}

/** 把环境事实压成一段话，供诊断时判断坑的条件是否匹配。 */
function renderEnvNote(store: Store): string {
  const envs = store.listEnvironments()
  if (envs.length === 0) return '（未采集到环境信息）'

  return envs
    .map((e) => {
      const f = e.facts
      const bits = [f.os, f.shell, f.gpu, f.cuda !== undefined ? `CUDA ${f.cuda}` : undefined]
        .filter((x): x is string => x !== undefined)
        .join('，')
      const quirks = f.quirks !== undefined && f.quirks.length > 0 ? `；注意：${f.quirks.join('；')}` : ''
      return `${e.name}：${bits}${quirks}`
    })
    .join('\n')
}

/** stdout 与 stderr 合并展示；stderr 单独标出来，否则看不出是哪一路。 */
function joinOutput(stdout: string, stderr: string): string {
  if (stderr.trim() === '') return stdout
  if (stdout.trim() === '') return stderr
  return `${stdout}\n--- stderr ---\n${stderr}`
}
