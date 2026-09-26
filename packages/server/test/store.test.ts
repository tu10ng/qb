import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { Store, type NewStep } from '../src/store.ts'

let store: Store
let me: string

beforeEach(() => {
  store = new Store(openDb({ path: ':memory:' }))
  me = store.ensureUser('tu10ng').id
})

describe('用户', () => {
  it('ensureUser 幂等', () => {
    const a = store.ensureUser('alice')
    const b = store.ensureUser('alice')
    expect(a.id).toBe(b.id)
  })
})

describe('任务', () => {
  it('默认派给自己', () => {
    const t = store.createTask({ title: '搞定 PD 分离', initiatorId: me })
    expect(t.assigneeId).toBe(me)
    expect(t.status).toBe('draft')
  })

  it('动手即开始，无需接受仪式', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.markTaskStarted(t.id, me)

    const after = store.getTask(t.id)!
    expect(after.status).toBe('active')
    expect(after.startedAt).not.toBeNull()
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('task_started')
  })

  it('重复 markTaskStarted 不重复记事件', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.markTaskStarted(t.id, me)
    store.markTaskStarted(t.id, me)
    expect(store.listEvents(t.id).filter((e) => e.kind === 'task_started')).toHaveLength(1)
  })

  it('按执行者和状态过滤', () => {
    const other = store.ensureUser('alice').id
    store.createTask({ title: 'mine', initiatorId: me })
    store.createTask({ title: 'theirs', initiatorId: me, assigneeId: other })

    expect(store.listTasks({ assigneeId: me })).toHaveLength(1)
    expect(store.listTasks({ assigneeId: other })).toHaveLength(1)
    expect(store.listTasks({ initiatorId: me })).toHaveLength(2)
  })
})

describe('Runbook', () => {
  const simpleSteps: NewStep[] = [
    { kind: 'command', title: '检查 GPU', command: 'nvidia-smi' },
    { kind: 'command', title: '起 decode', command: 'vllm serve' },
  ]

  it('创建时版本号从 1 开始', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { runbook, steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: simpleSteps,
    })

    expect(runbook.version).toBe(1)
    expect(steps).toHaveLength(2)
  })

  it('重规划产生新版本，旧版本保留', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.createRunbook({ taskId: t.id, createdBy: me, steps: simpleSteps })
    const second = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [{ kind: 'command', title: '改过的', command: 'echo' }],
    })

    expect(second.runbook.version).toBe(2)
    expect(store.listRunbookVersions(t.id)).toHaveLength(2)
    // 取到的是最新版
    expect(store.getLatestRunbook(t.id)!.runbook.version).toBe(2)
    expect(store.getLatestRunbook(t.id)!.steps[0]!.title).toBe('改过的')
  })

  it('步骤按 orderKey 有序', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [
        { kind: 'command', title: 'a' },
        { kind: 'command', title: 'b' },
        { kind: 'command', title: 'c' },
      ],
    })

    const keys = steps.map((s) => s.orderKey)
    expect([...keys].sort()).toEqual(keys)
    expect(steps.map((s) => s.title)).toEqual(['a', 'b', 'c'])
  })

  it('支持嵌套步骤（章节）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [
        {
          kind: 'note',
          title: '2 启动',
          children: [
            { kind: 'command', title: '2.1 decode', command: 'vllm serve' },
            { kind: 'wait', title: '2.2 等就绪' },
          ],
        },
      ],
    })

    const parent = steps.find((s) => s.title === '2 启动')!
    const children = steps.filter((s) => s.parentId === parent.id)
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.title)).toEqual(['2.1 decode', '2.2 等就绪'])
  })

  it('保存预期与探针', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [
        {
          kind: 'wait',
          title: '等 vLLM',
          expectation: { kind: 'contains', text: 'Started', caseSensitive: true },
          probe: { kind: 'http', url: 'http://gpu-17:8100/health', expectStatus: 200 },
          timeoutMs: 600_000,
          expectedMinutes: 8,
        },
      ],
    })

    const s = steps[0]!
    expect(s.expectation).toEqual({ kind: 'contains', text: 'Started', caseSensitive: true })
    expect(s.probe).toEqual({ kind: 'http', url: 'http://gpu-17:8100/health', expectStatus: 200 })
    expect(s.expectedMinutes).toBe(8)
  })

  it('保存假设列表', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { runbook } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      assumptions: [{ key: '集群', value: 'X', editedByUser: false }],
      steps: simpleSteps,
    })

    const loaded = store.getLatestRunbook(t.id)!
    expect(loaded.runbook.assumptions).toEqual(runbook.assumptions)
  })

  it('创建失败时不留半截 runbook', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    expect(() =>
      store.createRunbook({
        taskId: t.id,
        createdBy: me,
        steps: [{ kind: 'command', title: 'ok' }, { kind: 'command', title: 'bad', envId: 'nonexistent' }],
      }),
    ).toThrow()

    // 事务回滚，什么都没留下
    expect(store.getLatestRunbook(t.id)).toBeNull()
  })
})

describe('步骤状态', () => {
  it('记录耗时', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [{ kind: 'command', title: 'a', command: 'echo' }],
    })

    const s = steps[0]!
    store.updateStepStatus(s.id, 'running', { startedAt: 1000 })
    store.updateStepStatus(s.id, 'ok', { endedAt: 4000, actualMs: 3000 })

    const after = store.getStep(s.id)!
    expect(after.status).toBe('ok')
    expect(after.startedAt).toBe(1000)
    expect(after.actualMs).toBe(3000)
  })
})

describe('事件', () => {
  it('按时间正序返回', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.appendEvent({ taskId: t.id, kind: 'step_run', payload: { n: 1 } })
    store.appendEvent({ taskId: t.id, kind: 'step_ok', payload: { n: 2 } })

    const events = store.listEvents(t.id)
    expect(events.map((e) => e.kind)).toEqual(['step_run', 'step_ok'])
  })

  it('同一毫秒内的事件保持插入顺序', () => {
    // 事件常常在同一毫秒内连续写入（一步失败会立刻触发多条）。
    // 只按 created_at 排序会让时间线出现颠倒的因果。
    const t = store.createTask({ title: 'x', initiatorId: me })
    const kinds = ['step_run', 'step_failed', 'lesson_proposed', 'replanned'] as const
    for (const k of kinds) store.appendEvent({ taskId: t.id, kind: k })

    expect(store.listEvents(t.id).map((e) => e.kind)).toEqual([...kinds])
  })

  it('保存任意 payload', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.appendEvent({
      taskId: t.id,
      kind: 'situation_changed',
      payload: { reason: '审批人请假了', affectedSteps: ['s1', 's2'] },
    })

    const e = store.listEvents(t.id)[0]!
    expect(e.payload.reason).toBe('审批人请假了')
    expect(e.payload.affectedSteps).toEqual(['s1', 's2'])
  })
})

describe('递归委派', () => {
  it('子任务指向父步骤', () => {
    const alice = store.ensureUser('alice').id
    const parent = store.createTask({ title: '大任务', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: parent.id,
      createdBy: me,
      steps: [{ kind: 'delegate', title: '派给 alice' }],
    })

    const child = store.createTask({
      title: '子任务',
      initiatorId: me,
      assigneeId: alice,
      parentStepId: steps[0]!.id,
    })

    expect(child.parentStepId).toBe(steps[0]!.id)
    expect(child.assigneeId).toBe(alice)
  })
})
