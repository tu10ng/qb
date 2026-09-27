/**
 * 告警规则（纯函数，确定性——不靠模型）。
 *
 * 宪法 15：阻塞、反复失败、失败后无进展，由 QB 检测并主动告诉发起人。
 * 输入是执行侧已有的状态（任务 + 步骤 + 最近事件），输出是告警决策：
 * 升级、保持、还是解除。规则见方案 §7.2：
 *
 * 🔴 需要你（信件栈 + IM）：求助发出 / 标记阻塞 / 同一步连续失败 3 次 /
 *    失败后长时间无进展 / 运行远超预期且无输出
 * 🟡 值得一看（信件栈）：某步超预计 2 倍 / 任务超预计 1.5 倍 /
 *    进行中却长时间没有动静 / 派来很久还没开始
 * 🔵 进展：不在这里出告警，只进时间线
 *
 * "没有动静"只看执行者自己的动作（ACTIVITY_KINDS）。QB 和发起人产生的
 * 事件（告诉了发起人、评论、坑到达……）不算执行者有进展——否则 QB 一
 * 开口，停滞条件就被自己的那条事件"解除"，告警来回闪。
 *
 * 阈值都是可调参数（AlertThresholds）。
 */

import type { Event, EventKind, Step, Task } from './schema.ts'

export type AlertLevel = 'red' | 'yellow'

export interface AlertThresholds {
  /** 同一步连续失败几次升红。 */
  failStreak: number
  /** 失败后多少分钟无任何新事件算"停滞"。 */
  stalledAfterMs: number
  /** 运行中超过预计耗时的多少倍算失控。 */
  runAwayFactor: number
  /** 运行中多长时间没有输出算失控（配合 runAwayFactor）。 */
  runAwayNoOutputMs: number
  /** 某步实际耗时超过预计的多少倍值得一看。 */
  stepOvertimeFactor: number
  /** 任务总耗时超过预计的多少倍值得一看。 */
  taskOvertimeFactor: number
  /** 进行中的任务多久没有执行者动作算"没有动静"（当前步预计耗时的 2 倍更长时取它）。 */
  idleMs: number
  /** 别人派来的任务多久还没开始值得一看。 */
  notStartedMs: number
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  failStreak: 3,
  stalledAfterMs: 20 * 60_000,
  runAwayFactor: 3,
  runAwayNoOutputMs: 10 * 60_000,
  stepOvertimeFactor: 2,
  taskOvertimeFactor: 1.5,
  idleMs: 60 * 60_000,
  notStartedMs: 2 * 60 * 60_000,
}

/**
 * 执行者自己的动作。停滞、没有动静都按"最后一次执行者动作"算。
 */
export const ACTIVITY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'step_run',
  'step_ok',
  'step_failed',
  'step_timeout',
  'step_skipped',
  'edit',
  'reorder',
  'insert',
  'step_deleted',
  'step_restored',
  'situation_changed',
  'question_asked',
  'replanned',
  'task_started',
  'task_resumed',
  'task_reopened',
  'lesson_proposed',
])

/** 一条告警决策。key 用于去重与解除：同一 (task, step, type) 只有一条。 */
export interface AlertDecision {
  key: string
  taskId: string
  stepId: string | null
  level: AlertLevel
  type:
    | 'question' // 发出了求助
    | 'blocked' // 标记了被阻塞
    | 'fail_streak' // 同一步连续失败
    | 'stalled' // 失败后长时间没有进展
    | 'runaway' // 运行远超预期
    | 'step_overtime' // 某步超预计
    | 'task_overtime' // 任务整体超预计
    | 'idle' // 进行中却长时间没有动静
    | 'not_started' // 派来很久还没开始
  message: string
  /** 告警引用的事实时间（用于展示"已 18 分钟"）。 */
  at: number
}

export interface EscalateInput {
  now: number
  task: Task
  /** 当前 runbook 的步骤（先序）。 */
  steps: Step[]
  /** 该任务最近的事件（时间正序；给最近 200 条）。 */
  events: Event[]
  /** 运行中步骤的最近输出时间（引擎内存跟踪；没有输出的步骤不传）。 */
  lastOutputAt?: ReadonlyMap<string, number>
  thresholds?: Partial<AlertThresholds>
}

/**
 * 从状态推导当前应当存在的全部告警。
 *
 * 幂等：同一状态再算一遍结果一样。解除不需要单独的函数——调用方拿
 * 决策与现存告警做差集：不在决策里的现存告警即解除（步骤跑通了、
 * 问题回答了、任务结束了，条件自然消失）。
 */
export function evaluateAlerts(input: EscalateInput): AlertDecision[] {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds }
  const { task, steps, events, now } = input
  const out: AlertDecision[] = []
  if (task.status === 'done' || task.status === 'abandoned') return out

  const minutes = (ms: number): number => Math.round(ms / 60_000)
  const lastActivity = [...events].reverse().find((e) => ACTIVITY_KINDS.has(e.kind))

  // 🔴 求助发出：没有回答之前一直红
  const asked = [...events].reverse().find((e) => e.kind === 'question_asked' || e.kind === 'question_answered')
  if (asked !== undefined && asked.kind === 'question_asked') {
    out.push({
      key: `question:${asked.stepId ?? 'task'}`,
      taskId: task.id,
      stepId: asked.stepId,
      level: 'red',
      type: 'question',
      message: `发出了求助，还没有回答 · ${minutes(now - asked.createdAt)} 分钟`,
      at: asked.createdAt,
    })
  }

  // 🔴 标记阻塞：带上执行者写的那句原因
  if (task.status === 'blocked') {
    const blockedAt = [...events].reverse().find((e) => e.kind === 'task_blocked')
    const note = typeof blockedAt?.payload.note === 'string' ? blockedAt.payload.note.trim() : ''
    out.push({
      key: 'blocked:task',
      taskId: task.id,
      stepId: null,
      level: 'red',
      type: 'blocked',
      message: note !== '' ? `卡住了：${note}` : '卡住了，需要你介入',
      at: blockedAt?.createdAt ?? now,
    })
  }

  // 🔴 同一步连续失败 N 次：从最近的事件往回数，中间夹着别的结果就断掉
  for (const step of steps) {
    const streak = failStreakOf(events, step.id)
    if (streak >= t.failStreak) {
      const last = [...events].reverse().find((e) => e.stepId === step.id && e.kind === 'step_failed')
      out.push({
        key: `fail_streak:${step.id}`,
        taskId: task.id,
        stepId: step.id,
        level: 'red',
        type: 'fail_streak',
        message: `「${step.title}」连续失败 ${streak} 次`,
        at: last?.createdAt ?? now,
      })
    }
  }

  // 🔴 停滞：执行者最后一个动作是失败/超时，之后再也没有动静
  if (
    lastActivity !== undefined &&
    (lastActivity.kind === 'step_failed' || lastActivity.kind === 'step_timeout') &&
    now - lastActivity.createdAt >= t.stalledAfterMs
  ) {
    const step = steps.find((s) => s.id === lastActivity.stepId)
    out.push({
      key: `stalled:${lastActivity.stepId ?? 'task'}`,
      taskId: task.id,
      stepId: lastActivity.stepId,
      level: 'red',
      type: 'stalled',
      message: `失败后 ${minutes(now - lastActivity.createdAt)} 分钟没有进展${step !== undefined ? `（${step.title}）` : ''}`,
      at: lastActivity.createdAt,
    })
  }

  // 🔴 失控：正在跑的步骤远超预计耗时**且**最近 10 分钟没有任何输出。
  // 只看耗时不管输出会把正常的"长任务"（起 vLLM 要 8 分钟）误报。
  // 委派出去的步骤不在本机跑，由对方任务自己的告警负责。
  for (const step of steps) {
    if (step.kind === 'delegate') continue
    if (step.status !== 'running' || step.expectedMinutes === null || step.startedAt === null) continue
    const expectedMs = step.expectedMinutes * 60_000
    if (now - step.startedAt < expectedMs * t.runAwayFactor) continue
    const lastSeen = input.lastOutputAt?.get(step.id) ?? step.startedAt
    if (now - lastSeen < t.runAwayNoOutputMs) continue
    out.push({
      key: `runaway:${step.id}`,
      taskId: task.id,
      stepId: step.id,
      level: 'red',
      type: 'runaway',
      message: `「${step.title}」已运行 ${minutes(now - step.startedAt)} 分钟（预计 ${step.expectedMinutes} 分钟），${minutes(now - lastSeen)} 分钟没有输出`,
      at: lastSeen,
    })
  }

  // 🟡 某步超预计（已结束）
  for (const step of steps) {
    if (step.status !== 'failed' && step.status !== 'ok') continue
    if (step.expectedMinutes === null || step.actualMs === null) continue
    if (step.actualMs >= step.expectedMinutes * 60_000 * t.stepOvertimeFactor) {
      out.push({
        key: `step_overtime:${step.id}`,
        taskId: task.id,
        stepId: step.id,
        level: 'yellow',
        type: 'step_overtime',
        message: `「${step.title}」耗时 ${minutes(step.actualMs)} 分钟，预计 ${step.expectedMinutes} 分钟`,
        at: step.endedAt ?? now,
      })
    }
  }

  // 🟡 任务整体超预计
  const startedAt = task.startedAt
  if (startedAt !== null && task.expectedMinutes !== null && now - startedAt >= task.expectedMinutes * 60_000 * t.taskOvertimeFactor) {
    out.push({
      key: 'task_overtime:task',
      taskId: task.id,
      stepId: null,
      level: 'yellow',
      type: 'task_overtime',
      message: `任务已进行 ${minutes(now - startedAt)} 分钟，预计 ${task.expectedMinutes} 分钟`,
      at: now,
    })
  }

  // 🟡 没有动静：进行中、没卡住、没有步骤在跑，执行者却很久没动作。
  // 这是最常见的"沉默"——人在终端里对着报错发呆，QB 这边一个事件都没有。
  // 阈值至少是当前步预计耗时的 2 倍：手动执行的长步骤本来就没有事件。
  if (task.status === 'active' && !steps.some((s) => s.status === 'running')) {
    const current = currentStep(steps)
    const since = lastActivity?.createdAt ?? task.startedAt ?? task.createdAt
    const threshold = Math.max(t.idleMs, (current?.expectedMinutes ?? 0) * 60_000 * 2)
    if (now - since >= threshold) {
      out.push({
        key: `idle:${current?.id ?? 'task'}`,
        taskId: task.id,
        stepId: current?.id ?? null,
        level: 'yellow',
        type: 'idle',
        message: `${minutes(now - since)} 分钟没有动静${current !== undefined ? `（停在「${current.title}」）` : ''}`,
        at: since,
      })
    }
  }

  // 🟡 派来很久还没开始：别人派的活，执行者还一步都没动
  if (task.status === 'draft' && task.initiatorId !== task.assigneeId && now - task.createdAt >= t.notStartedMs) {
    out.push({
      key: 'not_started:task',
      taskId: task.id,
      stepId: null,
      level: 'yellow',
      type: 'not_started',
      message: `派来 ${minutes(now - task.createdAt)} 分钟了，还没开始`,
      at: task.createdAt,
    })
  }

  return out
}

/** 某一步从最近往回数的连续失败次数（遇到 ok/跳过/重置即断）。 */
function failStreakOf(events: Event[], stepId: string): number {
  let streak = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.stepId !== stepId) continue
    if (e.kind === 'step_failed' || e.kind === 'step_timeout') streak++
    else if (e.kind === 'step_ok' || e.kind === 'step_skipped' || e.kind === 'step_run') break
  }
  return streak
}

/** 当前步：文档顺序里第一个还没做完的步骤（章节标题和说明不算）。 */
function currentStep(steps: Step[]): Step | undefined {
  return steps.find((s) => s.kind !== 'note' && (s.status === 'pending' || s.status === 'failed' || s.status === 'blocked'))
}
