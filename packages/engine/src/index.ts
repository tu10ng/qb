import { NeedsConfirmation, runStep, type StepRunHandle } from './runner/run-step.ts'
import { createDshHostPort, type DshContext } from './dsh/host-port.ts'
import { Router, sendJson, errMessage } from './web/router.ts'
import { createWsHandler } from './web/ws.ts'
import { createSpaHandler } from './web/spa.ts'
import type { HostPort } from './dsh/port.ts'
import type { Expectation } from '@qb/core'

export const name = 'qb-engine'
// timer 是 cordis 的定时器服务：ctx.setInterval / setTimeout 都来自它，
// 不声明就取不到（cordis 的 inject 是强制的）。
export const inject = ['webServer', 'shell', 'timer']

export interface Config {
  /** SPA 构建产物目录。 */
  distDir: string
  /** 挂载前缀，默认 /qb。 */
  mountPath?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

export function apply(ctx: DshContext, config: Config): void {
  const mount = config.mountPath ?? '/qb'
  const host = createDshHostPort(ctx)
  const ws = createWsHandler()

  // 正在执行的步骤，用于取消和防重复启动
  const running = new Map<string, StepRunHandle>()

  const api = buildApi({ host, ws, running, mount })

  ctx.webServer.register({ kind: 'prefix', path: `${mount}/api`, handler: api.handle })
  ctx.webServer.registerUpgrade({ path: `${mount}/ws`, handler: ws.handler })
  ctx.webServer.register({ kind: 'prefix', path: mount, handler: createSpaHandler(config.distDir, mount) })

  // 启动自检的依据：dsh 会静默跳过 peer 版本不匹配的 bundle，
  // 所以这条日志是"插件真的加载了"的唯一凭证。
  console.log(`[qb] 已挂载 http://${ctx.webServer.host}:${ctx.webServer.port}${mount}`)
}

interface ApiDeps {
  host: HostPort
  ws: ReturnType<typeof createWsHandler>
  running: Map<string, StepRunHandle>
  mount: string
}

function buildApi({ host, ws, running, mount }: ApiDeps): Router {
  const router = new Router(`${mount}/api`)

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

  /**
   * 执行一步。
   *
   * 立刻返回，输出经 WS 推送。这样长任务（起 vLLM 要几分钟）不会
   * 卡住 HTTP 连接，前端也能在用户切走再回来时重新订阅。
   */
  router.post('/steps/:id/run', (_req, res, ctx) => {
    const stepId = ctx.params.id!
    const body = (ctx.body ?? {}) as {
      command?: string
      expectation?: Expectation | null
      timeoutMs?: number
      cwd?: string
      env?: Record<string, string>
      confirmed?: boolean
    }

    if (typeof body.command !== 'string' || body.command.trim() === '') {
      sendJson(res, 400, { error: 'bad_request', message: 'command 不能为空' })
      return
    }

    if (running.has(stepId)) {
      sendJson(res, 409, { error: 'already_running', message: '这一步正在执行' })
      return
    }

    let handle: StepRunHandle
    try {
      handle = runStep(host, {
        stepId,
        command: body.command,
        expectation: body.expectation ?? null,
        timeoutMs: body.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

    running.set(stepId, handle)
    ws.broadcast({ type: 'step.status', stepId, status: 'running' })

    handle.onChunk((chunk) => {
      ws.broadcast({ type: 'step.output', stepId, text: chunk.text, lossy: chunk.lossy })
    })

    void handle.outcome
      .then((outcome) => {
        running.delete(stepId)
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
    const killed = handle.cancel()
    sendJson(res, 200, { stepId, killed })
  })

  return router
}
