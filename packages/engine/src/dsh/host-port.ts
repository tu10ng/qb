import type {
  Completion,
  CompletionRequest,
  Disposable,
  HostPort,
  OutputChunk,
  RunRequest,
  RunResult,
  StreamingRun,
} from './port.ts'

/**
 * dsh 的 HostPort 实现。
 *
 * 这是整个代码库里唯一接触 dsh API 的文件（配合 port.ts 的类型定义）。
 * 依赖的 API 面记录在 docs/adr/0001-dsh-api-surface.md，升级 dsh 时
 * 只需回归这里。
 *
 * dsh 的 Context 类型不在我们的依赖里（它是 peer），所以这里用结构化
 * 类型描述我们实际用到的部分，避免把 @deepseek-ai/cordis 拖进编译。
 */

interface ShellExecRequest {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
}

interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
}

interface ShellRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  timeoutMs: number
  stdout: string
  stderr: string
}

interface ShellProcessRead {
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

interface ShellProcess {
  status: 'running' | 'completed' | 'killed'
  exitCode: number | null
  signal: NodeJS.Signals | null
  readonly done: Promise<void>
  readOutput(): ShellProcessRead
  kill(): boolean
}

/** dsh 的 webServer 服务（我们用到的部分）。 */
export interface DshWebServer {
  readonly port: number
  readonly host: string
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (
      req: import('node:http').IncomingMessage,
      socket: import('node:stream').Duplex,
      head: Buffer,
    ) => void | Promise<void>
  }): () => void
}

/** 我们用到的 dsh Context 子集。 */
export interface DshContext {
  shell: {
    resolve(request: ShellExecRequest): ShellExecSpec
    run(spec: ShellExecSpec): Promise<ShellRunResult>
    start(spec: ShellExecSpec): ShellProcess
  }
  webServer: DshWebServer
  /** cordis timer plugin：返回取消函数，插件卸载时自动清理。 */
  setTimeout(callback: () => void, delay: number): () => void
  setInterval(callback: () => void, delay: number): () => void
}

/** 流式输出的轮询间隔。够快到像实时，又不至于空转。 */
const POLL_INTERVAL_MS = 120

export function createDshHostPort(ctx: DshContext): HostPort {
  return {
    info: {
      get host() {
        return ctx.webServer.host
      },
      get port() {
        return ctx.webServer.port
      },
    },

    async runCommand(req: RunRequest): Promise<RunResult> {
      const startedAt = Date.now()
      const spec = ctx.shell.resolve(toShellRequest(req))
      const result = await ctx.shell.run(spec)
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt,
      }
    },

    startCommand(req: RunRequest): StreamingRun {
      const startedAt = Date.now()
      const spec = ctx.shell.resolve(toShellRequest(req))
      const proc = ctx.shell.start(spec)

      const listeners = new Set<(chunk: OutputChunk) => void>()
      // readOutput 是消费式的：读走就没了。所以自己留一份完整副本，
      // 供订阅晚于启动的消费者和最终结果使用。
      let collected = ''
      let sawLoss = false
      let timedOut = false

      const drain = (): void => {
        const read = proc.readOutput()
        if (read.delta === '' && !read.lossy) return

        collected += read.delta
        sawLoss ||= read.lossy

        const chunk: OutputChunk = {
          text: read.delta,
          lossy: read.lossy,
          ...(read.stdoutSpillPath !== undefined ? { spillPath: read.stdoutSpillPath } : {}),
        }
        for (const cb of listeners) cb(chunk)
      }

      // 用 ctx.setInterval 而非裸 setInterval：插件卸载时 cordis 自动清理，
      // 不会留下孤儿定时器。
      const stopPolling = ctx.setInterval(drain, POLL_INTERVAL_MS)

      // dsh 的 start() 明确不施加超时（"no timeout applies to background
      // processes"），超时只对 run() 生效。但 HostPort 的契约是两条路径
      // 语义一致，所以这里自己计时并 kill。
      const cancelTimeout = ctx.setTimeout(() => {
        timedOut = true
        proc.kill()
      }, req.timeoutMs)

      // 外部 abort 信号同样要终止进程
      const onAbort = (): void => {
        proc.kill()
      }
      req.signal?.addEventListener('abort', onAbort, { once: true })

      const done = proc.done.then((): RunResult => {
        stopPolling()
        cancelTimeout()
        req.signal?.removeEventListener('abort', onAbort)
        drain() // 收尾，确保进程结束前最后一批输出不丢

        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          stdout: collected,
          stderr: '', // start() 路径下 stderr 已合并进 delta
          timedOut,
          durationMs: Date.now() - startedAt,
        }
      })

      return {
        onChunk(cb) {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        done,
        kill: () => proc.kill(),
      }
    },

    async complete(_req: CompletionRequest): Promise<Completion> {
      // M3 接入。先明确失败而不是返回假数据——静默的空实现会让
      // 上层以为模型在工作。
      throw new Error('complete() 尚未实现：等 M3 接入 dsh 的 llm seam')
    },

    schedule(delayMs: number, fn: () => void): Disposable {
      const cancel = ctx.setTimeout(fn, delayMs)
      return { dispose: cancel }
    },
  }
}

function toShellRequest(req: RunRequest): ShellExecRequest {
  return {
    command: req.command,
    timeoutMs: req.timeoutMs,
    ...(req.cwd !== undefined ? { workdir: req.cwd } : {}),
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
  }
}
