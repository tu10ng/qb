import { redact, type ReadinessProbe } from '@qb/core'
import type { HostPort, RunResult } from '../dsh/port.ts'
import { pollReadiness } from './readiness.ts'

/**
 * wait 步骤："预计 8 分钟，我盯着，你先看下一步"。
 *
 * 两种用法：
 * - 运行并盯着：QB 起命令（起服务、下模型），同时轮询就绪条件
 * - 只盯着：命令是人在 SecureCRT 里跑的，QB 只在本机轮询 health 地址/端口
 *
 * 判定只看就绪条件，不看进程：
 * - 就绪 → 通过，进程留着（服务本来就该一直跑）
 * - 进程非 0 退出且还没就绪 → 失败（起都没起来）；0 退出（nohup … & 那种
 *   立刻返回的）继续盯
 * - 超时仍未就绪 → 失败，带上最后一次探测看到了什么；QB 起的进程收掉
 *
 * logPattern 探针在输出流上匹配，只能用于"运行并盯着"。
 */

/** QB 起的长进程最多留多久（服务本来就该一直跑；到点才收掉）。 */
const PROCESS_MAX_MS = 24 * 60 * 60_000

export interface WaitInput {
  /** null = 只盯着（命令在别处跑）。 */
  command: string | null
  probe: ReadinessProbe
  /** 等就绪最多多久。 */
  timeoutMs: number
  intervalMs?: number
  onAttempt?: (attempt: number, detail: string) => void
  /** 流式输出（已脱敏）。 */
  onChunk?: (text: string) => void
}

export interface WaitOutcome {
  ready: boolean
  detail: string
  attempts: number
  elapsedMs: number
  /** 命令的输出（已脱敏；只盯着时为空）。 */
  output: string
  /** 等待期间进程已经结束时的结果。 */
  exited: RunResult | null
  cancelled: boolean
}

export interface WaitHandle {
  readonly outcome: Promise<WaitOutcome>
  cancel(): boolean
}

export function runWaitStep(host: HostPort, input: WaitInput): WaitHandle {
  if (input.command === null && input.probe.kind === 'logPattern') {
    throw new Error('就绪条件是"日志出现某字样"，要跟着命令输出看——只盯着用不了，请用"运行并盯着"')
  }

  const startedAt = Date.now()
  const abort = new AbortController()
  let output = ''
  let exited: RunResult | null = null
  let cancelled = false

  const run =
    input.command !== null
      ? host.startCommand({ command: input.command, timeoutMs: PROCESS_MAX_MS, signal: abort.signal })
      : null

  // 取消要能直接收尾：日志模式下没有轮询循环可以"发现"取消
  let finishRef: (ready: boolean, detail: string) => void = () => undefined

  const outcome = new Promise<WaitOutcome>((resolve) => {
    let settled = false
    let attempts = 0
    const finish = (ready: boolean, detail: string): void => {
      if (settled) return
      settled = true
      // 没就绪：停止轮询，并收掉 QB 起的进程（占着端口的半截服务没用）。
      // 就绪：什么都不停——服务本来就该一直跑。
      if (!ready) abort.abort()
      resolve({ ready, detail, attempts, elapsedMs: Date.now() - startedAt, output, exited, cancelled })
    }
    finishRef = finish

    const pattern = input.probe.kind === 'logPattern' ? safeRegex(input.probe.pattern) : null

    run?.onChunk((chunk) => {
      const text = redact(chunk.text).text
      output += text
      input.onChunk?.(text)
      if (pattern !== null && pattern.test(output)) finish(true, `日志出现 /${input.probe.kind === 'logPattern' ? input.probe.pattern : ''}/`)
    })

    void run?.done.then((result) => {
      exited = result
      // 起都没起来：非 0 退出且还没就绪 → 失败；0 退出（后台化的命令）继续盯
      if (!settled && result.exitCode !== 0 && !cancelled) {
        const tail = output.trim().split('\n').slice(-3).join(' / ')
        finish(false, `命令先退出了（退出码 ${result.exitCode ?? '无'}）${tail !== '' ? `：${tail}` : ''}`)
      }
    })

    if (pattern !== null) {
      // 日志模式：输出流上匹配，这里只负责超时
      const t = host.schedule(input.timeoutMs, () => finish(false, `等了 ${Math.round(input.timeoutMs / 60_000)} 分钟，日志里还没出现 /${input.probe.kind === 'logPattern' ? input.probe.pattern : ''}/`))
      abort.signal.addEventListener('abort', () => t.dispose(), { once: true })
      return
    }

    void pollReadiness(host, input.probe, {
      timeoutMs: input.timeoutMs,
      ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
      signal: abort.signal,
      onAttempt: (n, detail) => {
        attempts = n
        input.onAttempt?.(n, detail)
      },
    }).then((r) => {
      attempts = r.attempts
      if (cancelled) finish(false, '已取消')
      else finish(r.ready, r.ready ? `就绪：${r.lastDetail}` : `等了 ${Math.round(r.elapsedMs / 60_000)} 分钟还没就绪：${r.lastDetail}`)
    })
  })

  return {
    outcome,
    cancel() {
      cancelled = true
      const killed = run?.kill() ?? true
      finishRef(false, '已取消')
      return killed
    },
  }
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'm')
  } catch {
    // 写坏的正则按字面量找
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm')
  }
}
