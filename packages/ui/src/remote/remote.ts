/**
 * 远程模式（团队服务）的 API 客户端。
 *
 * 同一份 UI 构建产物：引擎挂在 /qb/ 下，团队服务挂在 / 下。
 * 令牌放 localStorage（团队服务的个人令牌）。
 */

// 远程模式就是"团队服务在 / 下托管的那份界面"（main.tsx 按路径分流），团队
// 服务的 API 在 /api。原先写成 /qb/api——团队服务上那是 index.html，远程界面
// 登录、看任务全部失败（只有静态资源才走 vite 的 /qb/ 基准）
const BASE = '/api'
const TOKEN_KEY = 'qb-team-token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(getToken() !== '' ? { authorization: `Bearer ${getToken()}` } : {}),
      ...init?.headers,
    },
  })
  if (res.status === 401) {
    clearToken()
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>)
    throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export class UnauthorizedError extends Error {
  constructor() {
    super('令牌无效或未登录')
    this.name = 'UnauthorizedError'
  }
}

export interface RemoteTask {
  id: string
  title: string
  briefMd: string
  initiatorName: string
  assigneeName: string
  status: string
  expectedMinutes: number | null
  startedAt: number | null
  endedAt: number | null
  runbookVersion: number | null
  updatedAt: number
  total?: number
  done?: number
  worstAlert?: 'red' | 'yellow' | null
}

export interface RemoteStep {
  id: string
  parentId: string | null
  kind: string
  title: string
  command: string | null
  status: string
  expectedMinutes: number | null
  actualMs: number | null
  statusNote: string | null
  /** 执行者开了"共享输出"的步骤带最新输出。 */
  lastOutput?: string | null
}

export interface RemoteEvent {
  kind: string
  stepId: string | null
  actorName: string | null
  payload: Record<string, unknown>
  createdAt: number
}

export interface RemoteComment {
  id: string
  stepId: string | null
  authorName: string
  body: string
  createdAt: number
}

export interface RemoteQuestion {
  id: string
  stepId: string | null
  askerName: string
  body: string
  answer: string | null
  answeredByName: string | null
  answeredAt: number | null
  createdAt: number
}

export interface RemoteAlert {
  key: string
  taskId: string
  stepId: string | null
  level: 'red' | 'yellow'
  type: string
  message: string
  status: 'open' | 'ack' | 'resolved'
  createdAt: number
}

export interface RemoteDetail {
  task: RemoteTask
  steps: RemoteStep[]
  events: RemoteEvent[]
  comments: RemoteComment[]
  questions: RemoteQuestion[]
  alerts: RemoteAlert[]
}

export const remoteApi = {
  join: (invite: string, name: string) =>
    req<{ user: { displayName: string }; token: string }>('/join', { method: 'POST', body: JSON.stringify({ invite, name }) }),

  me: () => req<{ name: string; displayName: string; isAdmin: boolean }>('/me'),

  overview: () =>
    req<{ initiated: RemoteTask[]; assigned: RemoteTask[]; openAlerts: RemoteAlert[] }>('/overview'),

  task: (id: string) => req<RemoteDetail>(`/tasks/${id}`),

  comment: (taskId: string, body: string, stepId: string | null = null) =>
    req<RemoteComment>(`/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ body, stepId }) }),

  answer: (questionId: string, answer: string) =>
    req<RemoteQuestion>(`/questions/${questionId}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),

  ack: (key: string) => req<RemoteAlert>(`/alerts/${encodeURIComponent(key)}/ack`, { method: 'POST' }),

  // 坑确认（M9）：lesson_pending 告警的 [确认有效] / [不用了]
  confirmLesson: (lessonId: string, accept: boolean) =>
    req<unknown>(`/lessons/${lessonId}/confirm`, { method: 'POST', body: JSON.stringify({ accept }) }),

  // 远程派任务（PL → 执行者）
  users: () => req<{ users: Array<{ name: string; displayName: string; taskCount: number }> }>('/users'),

  dispatch: (input: { title: string; briefMd?: string; assigneeName: string; expectedMinutes?: number | null; definitionOfDone?: string | null }) =>
    req<{ taskId: string }>('/dispatch', { method: 'POST', body: JSON.stringify(input) }),

  // 推送渠道（通用 webhook / 外部命令如 python 脚本）
  channels: () => req<{ channels: Array<{ id: string; name: string; kind: 'webhook' | 'command'; config: Record<string, unknown>; minLevel: 'red' | 'yellow'; enabled: boolean }> }>('/push/channels'),

  saveChannel: (input: { id?: string; name: string; kind: 'webhook' | 'command'; config: Record<string, unknown>; minLevel: 'red' | 'yellow'; enabled: boolean }) =>
    req<{ channel: { id: string } }>('/push/channels', { method: 'POST', body: JSON.stringify(input) }),

  deleteChannel: (id: string) => req<{ ok: boolean }>(`/push/channels/${id}`, { method: 'DELETE' }),

  testChannel: (id: string) => req<{ ok: boolean; detail: string }>('/push/test', { method: 'POST', body: JSON.stringify({ id }) }),
}

/** 团队服务的实时刷新：连不上就退化为 15 秒轮询。 */
export function connectRefresh(onRefresh: () => void): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let retry = 0
  let timer: number | undefined

  const open = (): void => {
    if (stopped) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(getToken())}`)
    ws.addEventListener('open', () => (retry = 0))
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string }
        if (msg.type === 'refresh') onRefresh()
      } catch {
        /* 非 JSON 帧忽略 */
      }
    })
    ws.addEventListener('close', () => {
      if (stopped) return
      timer = window.setTimeout(open, Math.min(15_000, 500 * 2 ** retry++))
    })
  }
  open()
  const poll = window.setInterval(onRefresh, 15_000)

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    clearInterval(poll)
    ws?.close()
  }
}
