import type {
  Completion,
  CompletionRequest,
  Disposable,
  HostPort,
  OutputChunk,
  RunRequest,
  RunResult,
  StreamingRun,
} from '../src/dsh/port.ts'

export interface FakeRunSpec {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  /** 分片推送的流式输出。 */
  chunks?: string[]
  /** 延迟多久才结束（用假时钟推进）。 */
  settleAfterMs?: number
}

/**
 * 测试用 HostPort。
 *
 * 不起真进程，用预设脚本回答；定时器同步触发，让测试不依赖真实时间。
 */
export class FakeHost implements HostPort {
  readonly info = { host: '127.0.0.1', port: 3080 }
  readonly calls: RunRequest[] = []

  private script: FakeRunSpec[] = []
  private pendingTimers: Array<{ fn: () => void; delayMs: number }> = []

  /** 依次回答每次 runCommand/startCommand。用完后循环用最后一个。 */
  setScript(script: FakeRunSpec[]): void {
    this.script = script
  }

  private next(): FakeRunSpec {
    const idx = Math.min(this.calls.length - 1, this.script.length - 1)
    return this.script[idx] ?? {}
  }

  private toResult(spec: FakeRunSpec): RunResult {
    return {
      exitCode: spec.exitCode ?? 0,
      signal: null,
      stdout: spec.stdout ?? '',
      stderr: spec.stderr ?? '',
      timedOut: spec.timedOut ?? false,
      durationMs: spec.durationMs ?? 10,
    }
  }

  async runCommand(req: RunRequest): Promise<RunResult> {
    this.calls.push(req)
    return this.toResult(this.next())
  }

  startCommand(req: RunRequest): StreamingRun {
    this.calls.push(req)
    const spec = this.next()
    const listeners = new Set<(c: OutputChunk) => void>()
    let killed = false

    const done = new Promise<RunResult>((resolve) => {
      queueMicrotask(() => {
        for (const text of spec.chunks ?? []) {
          for (const cb of listeners) cb({ text, lossy: false })
        }
        resolve(killed ? { ...this.toResult(spec), exitCode: null, timedOut: true } : this.toResult(spec))
      })
    })

    return {
      onChunk(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      done,
      kill() {
        killed = true
        return true
      },
    }
  }

  async complete(_req: CompletionRequest): Promise<Completion> {
    return { text: '', model: 'fake' }
  }

  /** 假定时器：记录下来，由测试用 flushTimers 推进。 */
  schedule(delayMs: number, fn: () => void): Disposable {
    const entry = { fn, delayMs }
    this.pendingTimers.push(entry)
    return {
      dispose: () => {
        this.pendingTimers = this.pendingTimers.filter((t) => t !== entry)
      },
    }
  }

  /** 立刻触发所有挂起的定时器。 */
  flushTimers(): void {
    const timers = this.pendingTimers
    this.pendingTimers = []
    for (const t of timers) t.fn()
  }

  get pendingTimerCount(): number {
    return this.pendingTimers.length
  }
}
