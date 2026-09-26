import type { Event, Evidence, Runbook, Step, Task, User } from '@qb/core'

const BASE = '/qb/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>)
    throw new ApiError(res.status, body)
  }
  return (await res.json()) as T
}

/** 带上服务端返回的结构化错误，好让 UI 区分"需要确认"和真错误。 */
export class ApiError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }

  /** 破坏性命令等待用户点"确认运行"。 */
  get needsConfirmation(): boolean {
    return this.status === 409 && this.body.error === 'needs_confirmation'
  }

  get matched(): string[] {
    return Array.isArray(this.body.matched) ? (this.body.matched as string[]) : []
  }
}

export type JobStatus = 'running' | 'done' | 'failed'

export interface Job {
  id: string
  kind: string
  subjectId: string
  status: JobStatus
  startedAt: number
  endedAt: number | null
  error: string | null
  result: unknown
  progress: string | null
}

export interface Diagnosis {
  summary: string
  fromLessonId: string | null
  options: Array<{ label: string; detail: string; command?: string }>
  askInstead: string | null
  model: string
}

export interface TaskDetail {
  task: Task
  runbook: Runbook | null
  steps: Step[]
  events: Event[]
  /** 按步骤分组的历史证据——刷新后还能看到上次跑出了什么。 */
  evidence: Record<string, Evidence[]>
}

export const api = {
  me: () => req<User>('/me'),

  listTasks: (scope: 'mine' | 'delegated' = 'mine') =>
    req<{ tasks: Task[] }>(`/tasks?scope=${scope}`).then((r) => r.tasks),

  createTask: (input: { title: string; briefMd?: string }) =>
    req<Task>('/tasks', { method: 'POST', body: JSON.stringify(input) }),

  taskDetail: (taskId: string) => req<TaskDetail>(`/tasks/${taskId}/runbook`),

  /**
   * 让 QB 起草 runbook。立刻返回任务 id，结果经 WS 的 job.update 推送。
   * existing=true 表示已经有一个在跑了（连点两次不会起两份）。
   */
  draft: (taskId: string) =>
    req<{ jobId: string; status: JobStatus; existing: boolean }>(`/tasks/${taskId}/draft`, {
      method: 'POST',
    }),

  job: (jobId: string) => req<Job>(`/jobs/${jobId}`),

  writeRunbook: (
    taskId: string,
    input: { steps: unknown[]; assumptions?: unknown[]; reason?: string },
  ) =>
    req<{ runbook: Runbook; steps: Step[] }>(`/tasks/${taskId}/runbook`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  runStep: (stepId: string, opts: { confirmed?: boolean } = {}) =>
    req<{ stepId: string; status: string }>(`/steps/${stepId}/run`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  /** 让 QB 诊断一步的失败，给出可执行的路径。 */
  diagnose: (stepId: string) =>
    req<Diagnosis>(`/steps/${stepId}/diagnose`, { method: 'POST' }),

  /** 手动提交证据：自己跑完把输出贴回来，或直接标记完成。 */
  submitEvidence: (
    stepId: string,
    input: { text?: string; imageBase64?: string; markDone?: boolean },
  ) =>
    req<{ stepId: string; status: string; verdict: string | null; reason: string }>(
      `/steps/${stepId}/evidence`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  cancelStep: (stepId: string) =>
    req<{ stepId: string; killed: boolean }>(`/steps/${stepId}/cancel`, { method: 'POST' }),
}

// ── WebSocket ────────────────────────────────────────────────

export type ServerEvent =
  | { type: 'step.status'; stepId: string; status: string }
  | { type: 'step.output'; stepId: string; text: string; lossy: boolean }
  | {
      type: 'step.done'
      stepId: string
      verdict: 'pass' | 'fail' | 'unclear'
      reason: string
      exitCode: number | null
      timedOut: boolean
      durationMs: number
      danger: string
      redactionHits: string[]
    }
  | { type: 'step.error'; stepId: string; message: string }
  | { type: 'runbook.updated'; taskId: string; version: number }
  | { type: 'job.update'; job: Job }

/**
 * 连接事件流，断线自动重连。
 *
 * 用户切走再回来、笔记本休眠唤醒都会断线；执行中的步骤还在跑，
 * 所以重连后要能继续收到输出，而不是永远卡在"运行中"。
 */
export function connectEvents(onEvent: (e: ServerEvent) => void): () => void {
  let ws: WebSocket | null = null
  let retry = 0
  let stopped = false
  let timer: number | undefined

  const open = (): void => {
    if (stopped) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/qb/ws`)

    ws.addEventListener('open', () => {
      retry = 0
    })

    ws.addEventListener('message', (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as ServerEvent)
      } catch {
        // 非 JSON 帧忽略
      }
    })

    ws.addEventListener('close', () => {
      if (stopped) return
      // 指数退避，上限 10 秒——本机服务重启通常几秒内就绪
      const delay = Math.min(10_000, 500 * 2 ** retry++)
      timer = window.setTimeout(open, delay)
    })
  }

  open()

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    ws?.close()
  }
}
