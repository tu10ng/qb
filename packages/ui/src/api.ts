import type { Event, Evidence, Expectation, Param, Runbook, Step, StepKind, Task, User } from '@qb/core'

const BASE = '/qb/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // 引擎只接受 application/json 的写请求（挡跨站请求，见 local-guard.ts）
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

  /** 别的标签页先改了这一步；body.step 是最新内容。 */
  get conflict(): Step | null {
    return this.status === 409 && this.body.error === 'conflict' ? (this.body.step as Step) : null
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
  /** 进行中的后台任务（起草、看截图），刷新后接回进度。 */
  jobs: Job[]
  /** M7：导入来的 runbook 的保真报告；参数一改会跟着变。 */
  fidelity: FidelityView | null
  /** 任务最近贴进来的素材（有它才能"从素材整理"）。 */
  material: { id: string; kind: string; filename: string | null } | null
}

export interface FidelityView {
  items: Array<{ stepId: string; verbatim: boolean; unverified: boolean; closest: string | null }>
  uncoveredCount: number
  materialId: string | null
}

export interface BaseSuggestion {
  taskId: string
  title: string
  status: string
  runbookId: string
  version: number
  updatedAt: number
}

export interface LiteralSuggestionView {
  value: string
  count: number
  kind: string
  suggestedName: string
}

export interface AdaptProposal {
  paramChanges: Array<{ name: string; to: string; reason?: string }>
  newParams: Array<{ name: string; value: string; description?: string }>
  stepEdits: Array<{ stepIndex: number; command: string; reason?: string }>
  obsolete: Array<{ what: string; reason?: string }>
  questions: string[]
  rejectedStepEdits: Array<{ stepIndex: number; reason: string }>
  model: string
}

/** 起草时流式到达的步骤预览（还没落库）。 */
export interface PartialStep {
  section: string
  kind: string
  title: string
  command?: string
}

export interface NewStepInput {
  kind: StepKind
  title: string
  whyMd?: string | null
  command?: string | null
  expectation?: Expectation | null
  expectedMinutes?: number | null
}

export type StepPatchInput = Partial<Pick<Step, 'kind' | 'title' | 'whyMd' | 'command' | 'expectation' | 'expectedMinutes' | 'timeoutMs'>>

// ── 模型设置 ─────────────────────────────────────────────────

export type Purpose = 'structure' | 'diagnose' | 'vision'
export type Wire = 'anthropic' | 'openai-compatible' | 'deepseek'

export interface CheckResult {
  ok: boolean
  ms?: number
  detail?: string
}

export interface Capabilities {
  testedAt: number
  connect: CheckResult
  structured: CheckResult & { firstPartialMs?: number; partials?: number; jsonMode?: string }
  vision: CheckResult
}

export interface ProfileOptions {
  thinking: boolean
  effort?: 'low' | 'high' | 'max'
  maxOutputTokens: number
  timeoutMs: number
  jsonMode?: 'json_schema' | 'json_object'
  extraBody?: Record<string, unknown>
}

export interface PublicProfile {
  id: string
  name: string
  preset: string
  wire: Wire
  baseUrl: string
  model: string
  keyHint: string
  options: ProfileOptions
  capabilities: Capabilities | null
  source: 'local' | 'env'
  updatedAt: number
}

export interface Preset {
  id: string
  label: string
  wire: Wire
  baseUrl: string
  model: string
  note: string
  options: Partial<ProfileOptions>
}

export interface PurposeStatus {
  ok: boolean
  profileId: string | null
  profileName: string | null
  reason: string | null
}

export interface LlmSettingsView {
  profiles: PublicProfile[]
  purposes: Partial<Record<Purpose, string>>
  status: Record<Purpose, PurposeStatus>
  presets: Preset[]
}

export interface ProfileInput {
  id?: string
  name: string
  preset: string
  wire: Wire
  baseUrl: string
  model: string
  apiKey?: string
  options?: Partial<ProfileOptions>
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

  runStep: (stepId: string, opts: { confirmed?: boolean } = {}) =>
    req<{ stepId: string; status: string }>(`/steps/${stepId}/run`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  /** 让 QB 诊断一步的失败，给出可执行的路径。 */
  diagnose: (stepId: string) =>
    req<Diagnosis>(`/steps/${stepId}/diagnose`, { method: 'POST' }),

  /** 手动提交证据：自己跑完把输出或截图贴回来，或直接标记完成。 */
  submitEvidence: (
    stepId: string,
    input: { text?: string; imageBase64?: string; mediaType?: string; markDone?: boolean },
  ) =>
    req<{ stepId: string; status: string; verdict: string | null; reason: string; judging: boolean }>(
      `/steps/${stepId}/evidence`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  cancelStep: (stepId: string) =>
    req<{ stepId: string; killed: boolean }>(`/steps/${stepId}/cancel`, { method: 'POST' }),

  // ── 编辑（原地修改）─────────────────────────────────────────

  updateStep: (stepId: string, rev: number, patch: StepPatchInput) =>
    req<{ step: Step }>(`/steps/${stepId}`, { method: 'PATCH', body: JSON.stringify({ rev, ...patch }) }).then(
      (r) => r.step,
    ),

  insertStep: (runbookId: string, input: { parentId: string | null; afterId: string | null; step: NewStepInput }) =>
    req<{ step: Step }>(`/runbooks/${runbookId}/steps`, { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.step,
    ),

  moveStep: (stepId: string, rev: number, to: { parentId: string | null; afterId: string | null }) =>
    req<{ step: Step }>(`/steps/${stepId}/move`, { method: 'POST', body: JSON.stringify({ rev, ...to }) }).then(
      (r) => r.step,
    ),

  deleteStep: (stepId: string) => req<{ ids: string[] }>(`/steps/${stepId}`, { method: 'DELETE' }),

  restoreStep: (stepId: string) => req<{ ids: string[] }>(`/steps/${stepId}/restore`, { method: 'POST' }),

  setStepStatus: (stepId: string, status: 'pending' | 'ok' | 'failed' | 'skipped', note?: string) =>
    req<{ stepId: string; status: string }>(`/steps/${stepId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, ...(note !== undefined ? { note } : {}) }),
    }),

  // ── M7：从已有的开始 + 参数 ───────────────────────────────

  createMaterial: (taskId: string, input: { kind: string; text: string; filename?: string }) =>
    req<{ id: string; createdAt: number }>(`/tasks/${taskId}/material`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** 模式 B：把贴进来的素材忠实整理成 runbook（后台任务，流式出步骤）。 */
  importFromMaterial: (taskId: string, materialId: string) =>
    req<{ jobId: string; existing: boolean }>(`/tasks/${taskId}/import`, {
      method: 'POST',
      body: JSON.stringify({ materialId }),
    }),

  /** 找底稿。 */
  suggestBases: (q: string) =>
    req<{ suggestions: BaseSuggestion[] }>(`/tasks/suggest-bases?q=${encodeURIComponent(q)}`).then(
      (r) => r.suggestions,
    ),

  /** 模式 A 第一步：以一份 runbook 为基础复制（保留血缘与参数）。 */
  basedOn: (taskId: string, runbookId: string) =>
    req<{ runbook: Runbook; steps: Step[] }>(`/tasks/${taskId}/based-on`, {
      method: 'POST',
      body: JSON.stringify({ runbookId }),
    }),

  /** 差异提议（后台任务）；结果经 job.update 推送，不直接应用。 */
  adapt: (taskId: string, message: string) =>
    req<{ jobId: string; existing: boolean }>(`/tasks/${taskId}/adapt`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  adaptApply: (
    taskId: string,
    input: {
      paramChanges: Array<{ name: string; to: string }>
      newParams: Array<{ name: string; value: string; description?: string }>
      stepEdits: Array<{ stepId: string; command: string }>
      reason?: string
      expectedVersion?: number
    },
  ) => req<{ ok: boolean; summary: string }>(`/tasks/${taskId}/adapt/apply`, { method: 'POST', body: JSON.stringify(input) }),

  updateParams: (taskId: string, params: Param[]) =>
    req<{ params: Param[] }>(`/tasks/${taskId}/params`, { method: 'PATCH', body: JSON.stringify({ params }) }),

  suggestParams: (taskId: string) =>
    req<{ suggestions: LiteralSuggestionView[] }>(`/tasks/${taskId}/params/suggest`, { method: 'POST' }).then(
      (r) => r.suggestions,
    ),

  applySuggestions: (taskId: string, items: Array<{ value: string; name: string }>) =>
    req<{ touchedSteps: number }>(`/tasks/${taskId}/params/apply-suggestions`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  /** L0.5：贴一大段终端输出，按命令分回各步。 */
  submitTranscript: (taskId: string, text: string) =>
    req<{ matched: number; unmatched: string[] }>(`/tasks/${taskId}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // ── 设置 · 模型 ─────────────────────────────────────────────

  llmSettings: () => req<LlmSettingsView>('/settings/llm'),

  saveProfile: (input: ProfileInput) =>
    req<LlmSettingsView & { profile: PublicProfile }>('/settings/llm/profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteProfile: (id: string) => req<LlmSettingsView>(`/settings/llm/profiles/${id}`, { method: 'DELETE' }),

  setPurposes: (map: Partial<Record<Purpose, string | null>>) =>
    req<LlmSettingsView>('/settings/llm/purposes', { method: 'POST', body: JSON.stringify(map) }),

  testProfile: (id: string) =>
    req<{ jobId: string; existing: boolean }>(`/settings/llm/profiles/${id}/test`, { method: 'POST' }),

  listModels: (input: { profileId?: string; wire?: Wire; baseUrl?: string; apiKey?: string }) =>
    req<{ models: string[] }>('/settings/llm/models', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.models,
    ),
}

/** 截图证据的地址。 */
export function evidenceImageUrl(evidenceId: string): string {
  return `${BASE}/evidence/${evidenceId}/image`
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
  | { type: 'runbook.changed'; taskId: string; stepId: string | null }
  | { type: 'job.update'; job: Job }
  | { type: 'job.partial'; kind: string; subjectId: string; steps: PartialStep[] }

/**
 * 连接事件流，断线自动重连。
 *
 * 用户切走再回来、笔记本休眠唤醒都会断线；断线期间的 step.done /
 * job.update 永远收不到了，所以每次连上（含首次）都回调一次 onResync，
 * 由上层重拉当前数据——否则界面会卡在"运行中"直到手动刷新。
 */
export function connectEvents(onEvent: (e: ServerEvent) => void, onResync?: () => void): () => void {
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
      onResync?.()
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
