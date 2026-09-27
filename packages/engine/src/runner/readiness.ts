import { connect } from 'node:net'
import type { ReadinessProbe } from '@qb/core'
import type { HostPort } from '../dsh/port.ts'

export interface ProbeOutcome {
  ready: boolean
  attempts: number
  elapsedMs: number
  /** 最后一次探测的说明，用于在 QB 面板上讲清楚卡在哪。 */
  lastDetail: string
}

export interface ProbeOptions {
  intervalMs?: number
  timeoutMs: number
  signal?: AbortSignal
  /** 每次探测后回调，用于推进度到 UI（"第 12 次探测，还没就绪"）。 */
  onAttempt?: (attempt: number, detail: string) => void
}

const DEFAULT_INTERVAL_MS = 5_000

/**
 * 轮询就绪条件，直到就绪或超时。
 *
 * 用于 wait 步骤：起 vLLM、下模型、等外部审批。QB 在这段时间里
 * 对用户说"我盯着，你先看下一步"。
 */
export async function pollReadiness(
  host: HostPort,
  probe: ReadinessProbe,
  opts: ProbeOptions,
): Promise<ProbeOutcome> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const startedAt = Date.now()
  let attempts = 0
  let lastDetail = ''

  while (true) {
    if (opts.signal?.aborted === true) {
      return { ready: false, attempts, elapsedMs: Date.now() - startedAt, lastDetail: '已取消' }
    }

    attempts++
    const check = await probeOnce(host, probe, opts.signal)
    lastDetail = check.detail
    opts.onAttempt?.(attempts, check.detail)

    if (check.ready) {
      return { ready: true, attempts, elapsedMs: Date.now() - startedAt, lastDetail }
    }

    const elapsed = Date.now() - startedAt
    if (elapsed >= opts.timeoutMs) {
      return { ready: false, attempts, elapsedMs: elapsed, lastDetail }
    }

    // 剩余时间不足一个间隔时，就等剩余时间，不要冲过超时点。
    const wait = Math.min(interval, opts.timeoutMs - elapsed)
    await sleep(host, wait, opts.signal)
  }
}

interface ProbeCheck {
  ready: boolean
  detail: string
}

async function probeOnce(
  host: HostPort,
  probe: ReadinessProbe,
  signal: AbortSignal | undefined,
): Promise<ProbeCheck> {
  switch (probe.kind) {
    case 'http': {
      try {
        const res = await fetch(probe.url, {
          method: 'GET',
          ...(signal !== undefined ? { signal } : {}),
        })
        return res.status === probe.expectStatus
          ? { ready: true, detail: `${probe.url} 返回 ${res.status}` }
          : { ready: false, detail: `${probe.url} 返回 ${res.status}，期望 ${probe.expectStatus}` }
      } catch (e) {
        return { ready: false, detail: `${probe.url} 连接失败：${errMessage(e)}` }
      }
    }

    case 'port': {
      // 直接开 TCP 连接：原先拼 shell 命令（Windows 上 Test-NetConnection 一次
      // 要好几秒，host 还是拼进命令行的），这里既快又不经 shell
      const ok = await tcpProbe(probe.host, probe.port, 3000)
      return ok
        ? { ready: true, detail: `${probe.host}:${probe.port} 已监听` }
        : { ready: false, detail: `${probe.host}:${probe.port} 未监听` }
    }

    case 'command': {
      const r = await host.runCommand({
        command: probe.command,
        timeoutMs: 30_000,
        ...(signal !== undefined ? { signal } : {}),
      })
      return r.exitCode === probe.expectExitCode
        ? { ready: true, detail: `探测命令退出码 ${r.exitCode}` }
        : { ready: false, detail: `探测命令退出码 ${r.exitCode}，期望 ${probe.expectExitCode}` }
    }

    case 'logPattern':
      // 日志模式由调用方在流式输出上匹配（它持有输出流），
      // 这里不该重复读日志文件。
      return { ready: false, detail: '日志模式由输出流匹配，不走轮询' }
  }
}

/** 能不能连上 host:port（连上即关）。 */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

function sleep(host: HostPort, ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const handle = host.schedule(ms, resolve)
    signal?.addEventListener(
      'abort',
      () => {
        handle.dispose()
        resolve()
      },
      { once: true },
    )
  })
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
