import { describe, expect, it } from 'vitest'
import { evaluateAlerts, DEFAULT_THRESHOLDS, type AlertDecision } from '../src/escalate.ts'
import type { Event, Step, Task } from '../src/schema.ts'

/**
 * 告警规则（方案 §7.2）。用固定时钟；任务/步骤/事件用最小构造。
 * 每条规则一正一反：条件满足出告警，条件消失告警消失（差集解除）。
 */

const T0 = 1_000_000

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '在 X 集群部署 PD 分离',
    briefMd: '',
    initiatorId: 'u1',
    assigneeId: 'u2',
    parentStepId: null,
    status: 'active',
    expectedMinutes: 60,
    dueAt: null,
    definitionOfDone: null,
    createdAt: T0,
    startedAt: T0,
    endedAt: null,
    ...over,
  }
}

function step(over: Partial<Step> = {}): Step {
  return {
    id: 's1',
    runbookId: 'r1',
    parentId: null,
    orderKey: 'V',
    kind: 'command',
    title: '起 decode',
    whyMd: null,
    whySource: null,
    command: 'vllm serve',
    envId: null,
    expectation: null,
    probe: null,
    timeoutMs: null,
    expectedMinutes: 8,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    actualMs: null,
    delegateTaskId: null,
    rev: 0,
    lineageKey: null,
    origin: 'human',
    editedBy: null,
    sourceRef: null,
    statusNote: null,
    ...over,
  }
}

function event(kind: Event['kind'], over: Partial<Event> = {}): Event {
  return {
    id: `e${Math.random().toString(36).slice(2, 8)}`,
    taskId: 't1',
    stepId: 's1',
    actorId: 'u2',
    kind,
    payload: {},
    createdAt: T0,
    ...over,
  }
}

const at = (min: number) => T0 + min * 60_000
const run = (input: { now?: number; task?: Task; steps?: Step[]; events?: Event[]; thresholds?: object }) =>
  evaluateAlerts({
    now: input.now ?? at(60),
    task: input.task ?? task(),
    steps: input.steps ?? [step()],
    events: input.events ?? [],
    ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
  })

const find = (ds: AlertDecision[], type: AlertDecision['type']) => ds.find((d) => d.type === type)

describe('🔴 求助', () => {
  it('发出且未回答 → 红；回答后消失', () => {
    const asked = run({ events: [event('question_asked', { createdAt: at(10) })] })
    expect(find(asked, 'question')).toMatchObject({ level: 'red' })
    expect(find(asked, 'question')!.message).toContain('还没有回答')

    const answered = run({ events: [event('question_asked', { createdAt: at(10) }), event('question_answered', { createdAt: at(12) })] })
    expect(find(answered, 'question')).toBeUndefined()
  })
})

describe('🔴 阻塞', () => {
  it('任务标 blocked → 红；done 后不出任何告警', () => {
    expect(find(run({ task: task({ status: 'blocked' }) }), 'blocked')).toMatchObject({ level: 'red' })
    const done = run({ task: task({ status: 'done' }), events: [event('question_asked')] })
    expect(done).toEqual([])
  })
})

describe('🔴 连续失败', () => {
  it('同一步连续 3 次失败 → 红；中间跑通一次就断', () => {
    const fails = [1, 2, 3].map((i) => event('step_failed', { createdAt: at(i) }))
    expect(find(run({ events: fails }), 'fail_streak')).toMatchObject({ level: 'red', message: '「起 decode」连续失败 3 次' })

    const broken = [event('step_failed', { createdAt: at(1) }), event('step_failed', { createdAt: at(2) }), event('step_ok', { createdAt: at(3) }), event('step_failed', { createdAt: at(4) })]
    expect(find(run({ events: broken }), 'fail_streak')).toBeUndefined()
  })

  it('阈值可调：failStreak=2', () => {
    const two = [event('step_failed', { createdAt: at(1) }), event('step_failed', { createdAt: at(2) })]
    expect(find(run({ events: two, thresholds: { failStreak: 2 } }), 'fail_streak')).toBeDefined()
    expect(find(run({ events: two }), 'fail_streak')).toBeUndefined()
  })

  it('只数这一步的事件', () => {
    const mine = [event('step_failed', { createdAt: at(1) }), event('step_failed', { createdAt: at(2) })]
    const other = [event('step_failed', { stepId: 's9', createdAt: at(3) })]
    expect(find(run({ events: [...mine, ...other], thresholds: { failStreak: 3 } }), 'fail_streak')).toBeUndefined()
  })
})

describe('🔴 停滞', () => {
  it('最后一次事件是失败且 20 分钟无动静 → 红', () => {
    const stalled = run({ now: at(100), events: [event('step_failed', { createdAt: at(30) })] })
    expect(find(stalled, 'stalled')).toMatchObject({ level: 'red' })
    expect(find(stalled, 'stalled')!.message).toContain('70 分钟没有进展')
  })

  it('失败之后又有新事件（哪怕是别的步骤）就不算停滞', () => {
    const alive = run({ now: at(100), events: [event('step_failed', { createdAt: at(30) }), event('step_ok', { stepId: 's9', createdAt: at(50) })] })
    expect(find(alive, 'stalled')).toBeUndefined()
  })
})

describe('🔴 失控', () => {
  it('运行中超过预计 3 倍 → 红；结束/没在跑不出', () => {
    const running = step({ status: 'running', startedAt: at(0) })
    expect(find(run({ now: at(30), steps: [running] }), 'runaway')).toMatchObject({ level: 'red' })
    expect(find(run({ now: at(30), steps: [step({ status: 'running', startedAt: at(0), expectedMinutes: 8 })] }), 'runaway')).toBeDefined()

    // 预计 8 分钟，跑了 30 分钟 → 3.75 倍，红；只跑 20 分钟 → 2.5 倍，不红
    expect(find(run({ now: at(20), steps: [running] }), 'runaway')).toBeUndefined()
    expect(find(run({ now: at(30), steps: [step({ status: 'failed' })] }), 'runaway')).toBeUndefined()
  })
})

describe('🟡 超预计', () => {
  it('某步耗时超预计 2 倍 → 黄', () => {
    const slow = step({ status: 'ok', expectedMinutes: 8, actualMs: 20 * 60_000, endedAt: at(20) })
    expect(find(run({ steps: [slow] }), 'step_overtime')).toMatchObject({ level: 'yellow' })
  })

  it('任务整体超预计 1.5 倍 → 黄', () => {
    expect(find(run({ now: at(100), task: task({ expectedMinutes: 60 }) }), 'task_overtime')).toMatchObject({ level: 'yellow' })
    expect(find(run({ now: at(80) }), 'task_overtime')).toBeUndefined()
  })
})

describe('幂等与去重', () => {
  it('key 形如 type:stepId，可用作差集解除', () => {
    const ds = run({ events: [event('question_asked')] })
    expect(ds.every((d) => d.key === `${d.type}:${d.stepId ?? 'task'}` && d.taskId === 't1')).toBe(true)
  })

  it('同样的输入再算一遍结果一样', () => {
    const a = run({ events: [event('step_failed', { createdAt: at(1) }), event('step_failed', { createdAt: at(2) }), event('step_failed', { createdAt: at(3) })] })
    const b = run({ events: [event('step_failed', { createdAt: at(1) }), event('step_failed', { createdAt: at(2) }), event('step_failed', { createdAt: at(3) })] })
    expect(a).toEqual(b)
  })

  it('默认阈值完整（文档即代码）', () => {
    expect(DEFAULT_THRESHOLDS.failStreak).toBe(3)
    expect(DEFAULT_THRESHOLDS.stalledAfterMs).toBe(20 * 60_000)
  })
})
