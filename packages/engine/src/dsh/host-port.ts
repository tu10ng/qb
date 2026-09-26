import { sanitizeText } from '@qb/core'
import type { Disposable, HostPort, OutputChunk, RunRequest, RunResult, StreamingRun } from './port.ts'

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
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void | Promise<void>
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
  function startCommand(req: RunRequest): StreamingRun {
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

      // 命令输出不保证是合法 UTF-8（Windows 中文 locale 输出 GBK），
      // 在唯一入口清洗，避免非法代理项流进数据库和 JSON。
      const text = sanitizeText(read.delta)
      collected += text
      sawLoss ||= read.lossy

      const chunk: OutputChunk = {
        text,
        lossy: read.lossy,
        ...(read.stdoutSpillPath !== undefined ? { spillPath: read.stdoutSpillPath } : {}),
      }
      for (const cb of listeners) cb(chunk)
    }

    // 用 ctx.setInterval 而非裸 setInterval：插件卸载时 cordis 自动清理，
    // 不会留下孤儿定时器。
    const stopPolling = ctx.setInterval(drain, POLL_INTERVAL_MS)

    // dsh 的 start() 明确不施加超时（"no timeout applies to background
    // processes"），超时只对 run() 生效。我们自己计时并 kill。
    const cancelTimeout = ctx.setTimeout(() => {
      timedOut = true
      proc.kill()
    }, req.timeoutMs)

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
  }

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
      // 统一走 start() 而不是 run()：实测两者行为并不等价——同一条
      // PowerShell 命令在 run() 下拿不到输出，在 start() 下正常。
      // 超时已在 startCommand 里自行实现，语义不受影响。
      return startCommand(req).done
    },

    startCommand,

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
