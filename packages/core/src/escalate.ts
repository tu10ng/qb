/**
 * 告警规则（纯函数，确定性——不靠模型）。
 *
 * 宪法 15：阻塞、反复失败、失败后无进展，由 QB 检测并主动告诉发起人。
 * 输入是执行侧已有的状态（任务 + 步骤 + 最近事件），输出是告警决策：
 * 升级、保持、还是解除。规则见方案 §7.2：
 *
 * 🔴 需要你（信件栈 + IM）：求助发出 / 标记阻塞 / 同一步连续失败 3 次 /
 *    失败后长时间无进展 / 运行远超预期且无输出
 * 🟡 值得一看（信件栈）：某步超预计 2 倍 / 任务超预计 1.5 倍
 * 🔵 进展：不在这里出告警，只进时间线
 *
 * 阈值都是可调参数（AlertThresholds）。
 */

import type { Event, Step, Task } from './schema.ts'

export type AlertLevel = 'red' | 'yellow'

export interface AlertThresholds {
  /** 同一步连续失败几次升红。 */
  failStreak: number
  /** 失败后多少分钟无任何新事件算"停滞"。 */
  stalledAfterMs: number
  /** 运行中超过预计耗时的多少倍算失控。 */
  runAwayFactor: number
  /** 某步实际耗时超过预计的多少倍值得一看。 */
  stepOvertimeFactor: number
  /** 任务总耗时超过预计的多少倍值得一看。 */
  taskOvertimeFactor: number
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  failStreak: 3,
  stalledAfterMs: 20 * 60_000,
  runAwayFactor: 3,
  stepOvertimeFactor: 2,
  taskOvertimeFactor: 1.5,
}

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
  message: string
  /** 告警引用的事实时间（用于展示"已 18 分钟"）。 */
  at: number
}

export interface EscalateInput {
  now: number
  task: Task
  /** 当前 runbook 的步骤（先序）。 */
  steps: Step[]
  /** 该任务最近的事件（时间正序；给最近 50 条就够）。 */
  events: Event[]
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

  // 🔴 求助发出：没有回答之前一直红
  const asked = [...events].reverse().find((e) => e.kind === 'question_asked' || e.kind === 'question_answered')
  if (asked !== undefined && asked.kind === 'question_asked') {
    out.push({
      key: `question:${asked.stepId ?? 'task'}`,
      taskId: task.id,
      stepId: asked.stepId,
      level: 'red',
      type: 'question',
      message: `发出了求助，还没有回答 · ${Math.round((now - asked.createdAt) / 60_000)} 分钟`,
      at: asked.createdAt,
    })
  }

  // 🔴 标记阻塞
  if (task.status === 'blocked') {
    out.push({
      key: 'blocked:task',
      taskId: task.id,
      stepId: null,
      level: 'red',
      type: 'blocked',
      message: '任务被标记为阻塞',
      at: now,
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

  // 🔴 停滞：最近一次事件是失败/超时，之后再也没有动静
  const last = events[events.length - 1]
  if (
    last !== undefined &&
    (last.kind === 'step_failed' || last.kind === 'step_timeout') &&
    now - last.createdAt >= t.stalledAfterMs
  ) {
    const step = steps.find((s) => s.id === last.stepId)
    out.push({
      key: `stalled:${last.stepId ?? 'task'}`,
      taskId: task.id,
      stepId: last.stepId,
      level: 'red',
      type: 'stalled',
      message: `失败后 ${Math.round((now - last.createdAt) / 60_000)} 分钟没有进展${step !== undefined ? `（${step.title}）` : ''}`,
      at: last.createdAt,
    })
  }

  // 🔴 失控：正在跑的步骤远超预计耗时
  for (const step of steps) {
    if (step.status !== 'running' || step.expectedMinutes === null || step.startedAt === null) continue
    const expectedMs = step.expectedMinutes * 60_000
    if (now - step.startedAt >= expectedMs * t.runAwayFactor) {
      out.push({
        key: `runaway:${step.id}`,
        taskId: task.id,
        stepId: step.id,
        level: 'red',
        type: 'runaway',
        message: `「${step.title}」已运行 ${Math.round((now - step.startedAt) / 60_000)} 分钟，预计 ${step.expectedMinutes} 分钟`,
        at: step.startedAt,
      })
    }
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
        message: `「${step.title}」耗时 ${Math.round(step.actualMs / 60_000)} 分钟，预计 ${step.expectedMinutes} 分钟`,
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
      message: `任务已进行 ${Math.round((now - startedAt) / 60_000)} 分钟，预计 ${task.expectedMinutes} 分钟`,
      at: now,
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
