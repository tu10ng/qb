import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { RevConflict, Store, type NewStep } from '../src/store.ts'

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

describe('任务生命周期', () => {
  const kinds = (taskId: string) => store.listEvents(taskId).map((e) => e.kind)

  it('完成：打结束时间、记 task_done；再点一次不重复记', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.markTaskStarted(t.id, me)
    expect(store.setTaskStatus(t.id, 'done', me)).toBe(true)
    expect(store.setTaskStatus(t.id, 'done', me)).toBe(false)

    const after = store.getTask(t.id)!
    expect(after.status).toBe('done')
    expect(after.endedAt).not.toBeNull()
    expect(kinds(t.id).filter((k) => k === 'task_done')).toHaveLength(1)
  })

  it('卡住带原因；恢复记 task_resumed；只有卡住时 resumeIfBlocked 才动', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.markTaskStarted(t.id, me)
    store.resumeIfBlocked(t.id, me)
    expect(kinds(t.id)).not.toContain('task_resumed')

    store.setTaskStatus(t.id, 'blocked', me, { note: '等 gpu-18 的权限' })
    const blocked = store.listEvents(t.id).find((e) => e.kind === 'task_blocked')!
    expect(blocked.payload).toMatchObject({ note: '等 gpu-18 的权限', from: 'active' })

    store.resumeIfBlocked(t.id, me)
    expect(store.getTask(t.id)!.status).toBe('active')
    expect(store.listEvents(t.id).find((e) => e.kind === 'task_resumed')!.payload).toMatchObject({ auto: true })
  })

  it('完成后重新打开：清掉结束时间，记 task_reopened；放弃记 task_abandoned', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.setTaskStatus(t.id, 'done', me)
    store.setTaskStatus(t.id, 'active', me)
    expect(store.getTask(t.id)!.endedAt).toBeNull()
    expect(kinds(t.id)).toContain('task_reopened')

    store.setTaskStatus(t.id, 'abandoned', me, { note: '需求取消' })
    expect(store.getTask(t.id)!.endedAt).not.toBeNull()
    expect(kinds(t.id)).toContain('task_abandoned')
  })
})

describe('中文检索（FTS 二元组）', () => {
  it('纯中文标题能找到底稿：词、半截词、跨词都行', () => {
    store.createTask({ title: '升级驱动到 550', initiatorId: me })
    store.createTask({ title: '整理压测基线', initiatorId: me })
    store.createTask({ title: '在 X 集群部署 vLLM PD 分离', initiatorId: me })

    expect(store.searchTasks('升级驱动').map((t) => t.title)).toEqual(['升级驱动到 550'])
    expect(store.searchTasks('压测').map((t) => t.title)).toEqual(['整理压测基线'])
    expect(store.searchTasks('Y 集群的分离部署').map((t) => t.title)).toContain('在 X 集群部署 vLLM PD 分离')
    expect(store.searchTasks('完全无关的东西')).toEqual([])
  })

  it('坑的症状是中文也能检索到（原先单字查询永远不命中）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.createLesson({ anchorKind: 'free', symptom: 'decode 起来但 prefill 连不上，初始化卡住', fixMd: '设置网卡名', authorId: me, sourceTaskId: t.id })
    expect(store.searchLessons('启动时卡住了').map((l) => l.symptom)).toHaveLength(1)
    expect(store.searchLessons('初始化')).toHaveLength(1)
    // 远程下发的坑同样入索引
    store.upsertRemoteLesson({ id: 'lsn_remote1', anchorRef: 'lin_x', symptom: '驱动版本不一致', fixMd: '统一驱动', authorName: '老王', localAuthorId: me, createdAt: 1 })
    expect(store.searchLessons('驱动').map((l) => l.id)).toContain('lsn_remote1')
  })

  it('带 FTS 语法字符的查询不报错', () => {
    store.createTask({ title: '升级 vLLM v0.11.2', initiatorId: me })
    expect(() => store.searchTasks('v0.11.2 "quoted" -dash (paren) a*b: c^')).not.toThrow()
    expect(store.searchTasks('v0.11.2').map((t) => t.title)).toContain('升级 vLLM v0.11.2')
  })
})

describe('别人委派给我的任务（父步骤在对方机器上）', () => {
  it('能建起来，读回来父步骤 id 还在（原先外键失败、整批下行回滚）', () => {
    const t = store.createTask({ id: 'tsk_from_team', title: '压测', initiatorId: me, parentStepId: 'stp_on_other_machine' })
    expect(store.getTask(t.id)!.parentStepId).toBe('stp_on_other_machine')
  })

  it('父步骤在本机时仍走带外键的列', () => {
    const parent = store.createTask({ title: 'p', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: parent.id, createdBy: me, steps: [{ kind: 'delegate', title: '派' }] })
    const child = store.createTask({ title: 'c', initiatorId: me, parentStepId: steps[0]!.id })
    expect(store.getTask(child.id)!.parentStepId).toBe(steps[0]!.id)
  })
})

describe('委派关联（委派方本机）', () => {
  it('建关联、回流进度、按 runbook 取出', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { runbook, steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: '派出去的一步' }] })
    const d = store.createDelegation({ stepId: steps[0]!.id, teamTaskId: 'tsk_remote', assigneeName: 'xiaoa' })
    expect(d).toMatchObject({ teamTaskId: 'tsk_remote', assigneeName: 'xiaoa', status: 'draft', done: 0, total: 0 })

    const before = store.updateDelegationProgress(steps[0]!.id, { status: 'active', done: 2, total: 5, worstAlert: 'red' })
    expect(before?.done).toBe(0)
    expect(store.delegationsByRunbook(runbook.id)[steps[0]!.id]).toMatchObject({ status: 'active', done: 2, total: 5, worstAlert: 'red' })
    expect(store.updateDelegationProgress('nope', { status: 'done', done: 1, total: 1, worstAlert: null })).toBeNull()
  })
})

describe('下行去重', () => {
  it('按 payload 里指定的字段判重（评论写的是 commentId）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.appendEvent({ taskId: t.id, kind: 'comment', payload: { commentId: 'cmt_1', body: 'hi' } })
    expect(store.hasEventWithPayloadId('comment', 'cmt_1', 'commentId')).toBe(true)
    expect(store.hasEventWithPayloadId('comment', 'cmt_2', 'commentId')).toBe(false)
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

  it('多章节的子步骤不会串到别的章节下', () => {
    // orderKey 只在兄弟间唯一，所以不能全局排序——否则各章节的
    // 子步骤会按 key 大小混在一起。
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      steps: [
        {
          kind: 'note',
          title: '1 准备',
          children: [
            { kind: 'command', title: '1.1' },
            { kind: 'command', title: '1.2' },
          ],
        },
        {
          kind: 'note',
          title: '2 启动',
          children: [
            { kind: 'command', title: '2.1' },
            { kind: 'command', title: '2.2' },
            { kind: 'command', title: '2.3' },
          ],
        },
        {
          kind: 'note',
          title: '3 验证',
          children: [{ kind: 'command', title: '3.1' }],
        },
      ],
    })

    expect(steps.map((s) => s.title)).toEqual([
      '1 准备',
      '1.1',
      '1.2',
      '2 启动',
      '2.1',
      '2.2',
      '2.3',
      '3 验证',
      '3.1',
    ])

    // 读回来的顺序必须和写入时一致
    const loaded = store.getLatestRunbook(t.id)!
    expect(loaded.steps.map((s) => s.title)).toEqual(steps.map((s) => s.title))
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

describe('编辑：原地修改', () => {
  /** 两个章节、各两步的 runbook。 */
  function seed() {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { runbook, steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      origin: 'draft',
      steps: [
        {
          kind: 'note',
          title: '1 准备',
          children: [
            { kind: 'command', title: 'a', command: 'echo a' },
            { kind: 'command', title: 'b', command: 'echo b' },
          ],
        },
        {
          kind: 'note',
          title: '2 启动',
          children: [
            { kind: 'command', title: 'c', command: 'echo c' },
            { kind: 'command', title: 'd', command: 'echo d' },
          ],
        },
      ],
    })
    const by = (title: string) => steps.find((s) => s.title === title)!
    const titles = () => store.listSteps(runbook.id).map((s) => s.title)
    return { runbook, by, titles }
  }

  it('新步骤带血缘、rev 从 0 开始、记录来源', () => {
    const { by } = seed()
    const a = by('a')
    expect(a.rev).toBe(0)
    expect(a.origin).toBe('qb')
    expect(a.lineageKey).toMatch(/^lin_/)
    expect(a.editedBy).toBeNull()
    expect(by('b').lineageKey).not.toBe(a.lineageKey)
  })

  it('改内容：rev +1、记下是谁改的、返回改前改后', () => {
    const { by } = seed()
    const a = by('a')
    const { step, changes } = store.updateStep(
      a.id,
      { command: 'echo A', title: 'a' /* 没变的字段不算改动 */ },
      { expectedRev: 0, actorId: me },
    )
    expect(step.command).toBe('echo A')
    expect(step.rev).toBe(1)
    expect(step.editedBy).toBe(me)
    // 血缘不因编辑而变：改过的仍是"同一步"，坑还挂得上
    expect(step.lineageKey).toBe(a.lineageKey)
    expect(changes).toEqual([{ field: 'command', before: 'echo a', after: 'echo A' }])
  })

  it('没有实际变化时不动 rev', () => {
    const { by } = seed()
    const { step, changes } = store.updateStep(by('a').id, { command: 'echo a' }, { expectedRev: 0, actorId: me })
    expect(changes).toEqual([])
    expect(step.rev).toBe(0)
  })

  it('rev 过期时拒绝并带回最新内容，不静默覆盖', () => {
    const { by } = seed()
    const a = by('a')
    store.updateStep(a.id, { command: 'echo 1' }, { expectedRev: 0, actorId: me })

    try {
      store.updateStep(a.id, { command: 'echo 2' }, { expectedRev: 0, actorId: me })
      expect.unreachable('应当冲突')
    } catch (e) {
      expect(e).toBeInstanceOf(RevConflict)
      expect((e as RevConflict).current.command).toBe('echo 1')
    }
    expect(store.getStep(a.id)!.command).toBe('echo 1')
  })

  it('插入：放在某一步之后、放在最前、放进另一个章节', () => {
    const { runbook, by, titles } = seed()
    const section1 = by('1 准备')
    const section2 = by('2 启动')

    const x = store.insertStep({
      runbookId: runbook.id,
      parentId: section1.id,
      afterId: by('a').id,
      step: { kind: 'command', title: 'x', command: 'echo x' },
    })
    expect(x.origin).toBe('human')
    store.insertStep({ runbookId: runbook.id, parentId: section2.id, afterId: null, step: { kind: 'check', title: 'first' } })
    store.insertStep({ runbookId: runbook.id, parentId: null, afterId: section2.id, step: { kind: 'note', title: '3 验证' } })

    expect(titles()).toEqual(['1 准备', 'a', 'x', 'b', '2 启动', 'first', 'c', 'd', '3 验证'])
  })

  it('插入位置的兄弟不在同一层时报错', () => {
    const { runbook, by } = seed()
    expect(() =>
      store.insertStep({
        runbookId: runbook.id,
        parentId: by('1 准备').id,
        afterId: by('c').id, // c 在第 2 章
        step: { kind: 'command', title: 'x' },
      }),
    ).toThrow(/同一层/)
  })

  it('移动：同层重排、跨章节移动', () => {
    const { by, titles } = seed()
    const b = by('b')
    // b 移到 a 前面
    store.moveStep(b.id, { parentId: by('1 准备').id, afterId: null }, { expectedRev: 0 })
    expect(titles()).toEqual(['1 准备', 'b', 'a', '2 启动', 'c', 'd'])

    // a 移到第 2 章的 c 后面
    const { step, from } = store.moveStep(by('a').id, { parentId: by('2 启动').id, afterId: by('c').id }, { expectedRev: 0 })
    expect(from.parentId).toBe(by('1 准备').id)
    expect(step.parentId).toBe(by('2 启动').id)
    expect(step.rev).toBe(1)
    expect(titles()).toEqual(['1 准备', 'b', '2 启动', 'c', 'a', 'd'])
  })

  it('不能把章节移进它自己的子步骤下面', () => {
    const { by } = seed()
    expect(() =>
      store.moveStep(by('1 准备').id, { parentId: by('a').id, afterId: null }, { expectedRev: 0 }),
    ).toThrow(/子步骤/)
  })

  it('删除章节连同子步骤一起隐藏；撤销整批恢复', () => {
    const { by, titles } = seed()
    const { ids } = store.deleteStep(by('1 准备').id)
    expect(ids).toHaveLength(3)
    expect(titles()).toEqual(['2 启动', 'c', 'd'])
    // 删掉的步骤取不到，也就不能运行、不能编辑
    expect(store.getStep(by('a').id)).toBeNull()
    expect(store.getStep(by('a').id, { includeDeleted: true })!.title).toBe('a')

    store.restoreStep(by('1 准备').id)
    expect(titles()).toEqual(['1 准备', 'a', 'b', '2 启动', 'c', 'd'])
  })

  it('撤销删除章节时，不把之前单独删掉的子步骤带回来', () => {
    const { by, titles } = seed()
    store.deleteStep(by('b').id)
    store.deleteStep(by('1 准备').id)
    store.restoreStep(by('1 准备').id)
    expect(titles()).toEqual(['1 准备', 'a', '2 启动', 'c', 'd'])
  })

  it('删除后在原位置插入新步骤，撤销删除时顺序不乱', () => {
    const { runbook, by, titles } = seed()
    const section1 = by('1 准备')
    store.deleteStep(by('b').id)
    store.insertStep({ runbookId: runbook.id, parentId: section1.id, afterId: by('a').id, step: { kind: 'command', title: 'new' } })
    store.restoreStep(by('b').id)

    const inSection = titles().slice(1, 4)
    expect(inSection).toContain('new')
    expect(inSection).toContain('b')
    // 所有兄弟的键仍然两两不同
    const keys = store.listSteps(runbook.id).filter((s) => s.parentId === section1.id).map((s) => s.orderKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('跳过/失败的原因写进 statusNote；自动判定不会抹掉它', () => {
    const { by } = seed()
    const a = by('a')
    store.updateStepStatus(a.id, 'skipped', { note: '这台机器已经装过了' })
    expect(store.getStep(a.id)!.statusNote).toBe('这台机器已经装过了')
    store.updateStepStatus(a.id, 'ok', { endedAt: 1 })
    expect(store.getStep(a.id)!.statusNote).toBe('这台机器已经装过了')
  })

  it('重置为未开始时清掉时间戳——否则步骤显示上一次的耗时', () => {
    const { by } = seed()
    const a = by('a')
    store.updateStepStatus(a.id, 'running', { startedAt: 1000 })
    store.updateStepStatus(a.id, 'ok', { endedAt: 4000, actualMs: 3000 })
    store.updateStepStatus(a.id, 'pending', { resetTimings: true })

    const after = store.getStep(a.id)!
    expect(after.startedAt).toBeNull()
    expect(after.endedAt).toBeNull()
    expect(after.actualMs).toBeNull()
  })

  it('subtreeIds 返回整棵子树', () => {
    const { by } = seed()
    const ids = store.subtreeIds(by('1 准备').id)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(by('a').id)
    expect(ids).toContain(by('b').id)
    expect(store.subtreeIds(by('a').id)).toEqual([by('a').id])
  })

  it('大改前的快照', () => {
    const { runbook, titles } = seed()
    store.snapshotRunbook(runbook.id, '导入前', me)
    const [snap] = store.listSnapshots(runbook.id)
    expect(snap!.reason).toBe('导入前')
    expect(snap!.steps.map((s) => s.title)).toEqual(titles())
  })

  it('最近一次编辑事件', () => {
    const { runbook, by } = seed()
    const a = by('a')
    store.appendEvent({ taskId: runbook.taskId, stepId: a.id, kind: 'edit', payload: { changes: [1] } })
    store.appendEvent({ taskId: runbook.taskId, stepId: a.id, kind: 'edit', payload: { changes: [2] } })
    expect(store.lastEditOf(a.id)!.payload.changes).toEqual([2])
  })
})

describe('M7：参数 / 底稿 / 素材', () => {
  const seedParams = () => {
    const t = store.createTask({ title: '在 X 集群部署 vLLM PD 分离', briefMd: 'Qwen2.5-72B', initiatorId: me })
    const { runbook, steps } = store.createRunbook({
      taskId: t.id,
      createdBy: me,
      origin: 'import',
      params: [
        { name: 'DECODE_HOST', value: 'gpu-18', source: 'origin', secret: false },
        { name: 'MODEL_PATH', value: '/data/models/Qwen2.5-72B', source: 'origin', secret: false },
        { name: 'PROXY_IP', value: '10.0.3.17', source: 'origin', secret: false },
      ],
      steps: [
        {
          kind: 'note',
          title: '1 启动',
          children: [
            { kind: 'command', title: '起 decode', command: 'ssh {{DECODE_HOST}} vllm serve {{MODEL_PATH}}', sourceRef: 'mat_x#L12' },
          ],
        },
      ],
    })
    return { task: t, runbook, steps }
  }

  it('参数随 runbook 存取', () => {
    const { runbook } = seedParams()
    const loaded = store.getLatestRunbook(runbook.taskId)!.runbook
    expect(loaded.params).toHaveLength(3)
    expect(loaded.origin).toBe('import')
    expect(loaded.params[0]).toMatchObject({ name: 'DECODE_HOST', value: 'gpu-18', source: 'origin' })
  })

  it('updateRunbookParams 覆盖参数并标记来源', () => {
    const { runbook } = seedParams()
    store.updateRunbookParams(runbook.id, [{ name: 'DECODE_HOST', value: 'gpu-19', source: 'mine', secret: false }])
    const loaded = store.getLatestRunbook(runbook.taskId)!.runbook
    expect(loaded.params).toEqual([{ name: 'DECODE_HOST', value: 'gpu-19', source: 'mine', secret: false }])
  })

  it('copyRunbook：血缘保留、步骤来源 base、参数来源 base、记下底稿', () => {
    const { task, runbook, steps } = seedParams()
    const t2 = store.createTask({ title: '在 Y 集群部署 PD 分离', briefMd: '', initiatorId: me })
    const copied = store.copyRunbook(runbook.id, t2.id, me)

    const decode = copied.steps.find((s) => s.title === '起 decode')!
    expect(decode.lineageKey).toBe(steps.find((s) => s.title === '起 decode')!.lineageKey)
    expect(decode.origin).toBe('base')
    expect(copied.runbook.baseRunbookId).toBe(runbook.id)
    expect(copied.runbook.origin).toBe('copy')
    expect(copied.runbook.params).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'DECODE_HOST', source: 'base' })]),
    )
    // 原任务不受影响
    expect(store.getLatestRunbook(task.id)!.runbook.id).toBe(runbook.id)
  })

  it('素材：写入、读取、最近一份', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const m1 = store.createMaterial({ taskId: t.id, kind: 'doc', text: '第一份', createdBy: me })
    store.createMaterial({ taskId: t.id, kind: 'terminal', text: '第二份', createdBy: me })

    expect(store.getMaterial(m1.id)!.text).toBe('第一份')
    expect(store.getMaterial('mat_none')).toBeNull()
    expect(store.latestMaterial(t.id)!.kind).toBe('terminal')
  })

  it('searchTasks：按标题与描述找底稿', () => {
    seedParams()
    store.createTask({ title: ' unrelated 整理周报', initiatorId: me })

    const hits = store.searchTasks('vllm PD 分离')
    expect(hits.map((t) => t.title)).toContain('在 X 集群部署 vLLM PD 分离')
    // 中文按字切、OR 匹配，单字查询天然很宽；用一个肯定不存在的词验证空结果
    expect(store.searchTasks('zzzqwer')).toEqual([])
  })

  it('hasLesson：同任务同症状判重（重复导入去重用）', () => {
    const { task } = seedParams()
    expect(store.hasLesson(task.id, 'NCCL 卡初始化')).toBe(false)
    store.createLesson({ anchorKind: 'free', symptom: 'NCCL 卡初始化', fixMd: '比对驱动', authorId: me, sourceTaskId: task.id })
    expect(store.hasLesson(task.id, 'NCCL 卡初始化')).toBe(true)
    expect(store.hasLesson(task.id, '别的症状')).toBe(false)
  })

  it('inTransaction：中途抛错整体回滚', () => {
    const { task } = seedParams()
    const before = store.getLatestRunbook(task.id)!.runbook.params
    expect(() =>
      store.inTransaction(() => {
        store.updateRunbookParams(store.getLatestRunbook(task.id)!.runbook.id, [
          { name: 'X', value: 'y', source: 'mine', secret: false },
        ])
        throw new Error('中途失败')
      }),
    ).toThrow('中途失败')
    expect(store.getLatestRunbook(task.id)!.runbook.params).toEqual(before)
  })
})

describe('M8：求助与同步游标', () => {
  it('求助：建、答、待推列表、标记已推', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { id } = store.createQuestion({ taskId: t.id, stepId: null, askerId: me, bodyMd: 'hostname 是什么？' })
    expect(store.listUnpushedQuestions()).toHaveLength(1)

    expect(store.answerQuestion(id, 'gpu-21')).toBe(true)
    expect(store.answerQuestion('qst_none', 'x')).toBe(false)
    const q = store.getQuestion(id)!
    expect(q.answerMd).toBe('gpu-21')
    expect(q.answeredAt).not.toBeNull()
    // 回答由团队回流时直接标已推
    expect(q.pushed).toBe(true)

    store.markQuestionsPushed([id])
    expect(store.listUnpushedQuestions()).toEqual([])
  })

  it('同步游标与带 seq 的事件', () => {
    const t = store.createTask({ title: 'y', initiatorId: me })
    store.appendEvent({ taskId: t.id, kind: 'step_run' })
    store.appendEvent({ taskId: t.id, kind: 'step_ok' })
    expect(store.maxEventSeq()).toBeGreaterThanOrEqual(2)
    const after = store.eventsAfter(0)
    expect(after).toHaveLength(2)
    expect(after[0]!.seq).toBeLessThan(after[1]!.seq)

    expect(store.getSyncState('x')).toBeNull()
    store.setSyncState('x', { a: 1 })
    store.setSyncState('x', { a: 2 })
    expect(store.getSyncState<{ a: number }>('x')).toEqual({ a: 2 })
  })
})

describe('本机设置', () => {
  it('模型档案：新建、覆盖、删除', () => {
    const p = store.saveModelProfile({
      name: 'DeepSeek flash',
      preset: 'deepseek',
      wire: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
      options: { thinking: false },
      capabilities: null,
    })
    expect(store.listModelProfiles()).toHaveLength(1)

    const updated = store.saveModelProfile({ ...p, model: 'deepseek-v4-pro', capabilities: { ok: true } })
    expect(updated.id).toBe(p.id)
    expect(updated.createdAt).toBe(p.createdAt)
    expect(store.getModelProfile(p.id)!.model).toBe('deepseek-v4-pro')
    expect(store.getModelProfile(p.id)!.capabilities).toEqual({ ok: true })

    store.deleteModelProfile(p.id)
    expect(store.listModelProfiles()).toHaveLength(0)
  })

  it('键值设置', () => {
    expect(store.getSetting('llm.purposes')).toBeNull()
    store.setSetting('llm.purposes', { structure: 'mdl_1' })
    store.setSetting('llm.purposes', { structure: 'mdl_2' })
    expect(store.getSetting('llm.purposes')).toEqual({ structure: 'mdl_2' })
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

describe('坑：血缘锚定 / 共享 / 命中统计（M9）', () => {
  const linSteps: NewStep[] = [
    { kind: 'command', title: '起 decode', command: 'vllm serve', lineageKey: 'lin_decode' },
    { kind: 'command', title: '起 prefill', command: 'vllm serve --port 8100', lineageKey: 'lin_prefill' },
  ]

  function setup(): { taskId: string; steps: ReturnType<Store['createRunbook']>['steps'] } {
    const t = store.createTask({ title: 'Y 集群', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: linSteps })
    return { taskId: t.id, steps }
  }

  it('lessonsForLineages 只取血缘锚定的坑', () => {
    const { taskId, steps } = setup()
    store.createLesson({ anchorKind: 'step_lineage', anchorRef: 'lin_decode', symptom: 'No route to host', fixMd: 'NCCL_SOCKET_IFNAME=eth0', authorId: me, sourceTaskId: taskId })
    store.createLesson({ anchorKind: 'free', anchorRef: null, symptom: '自由坑', fixMd: '随便', authorId: me })

    const hits = store.lessonsForLineages(['lin_decode', steps[1]!.lineageKey!])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.anchorRef).toBe('lin_decode')
  })

  it('upload 流：team 坑进上传队列，标记后出队', () => {
    const { taskId } = setup()
    const personal = store.createLesson({ anchorKind: 'free', symptom: 'p', fixMd: 'f', authorId: me, sourceTaskId: taskId })
    const team = store.createLesson({ anchorKind: 'step_lineage', anchorRef: 'lin_decode', symptom: 's', fixMd: 'f', authorId: me, sourceTaskId: taskId, scope: 'team' })

    expect(store.listLessonsToUpload().map((l) => l.id)).toEqual([team.id])
    store.markLessonsUploaded([team.id])
    expect(store.listLessonsToUpload()).toHaveLength(0)
    expect(personal.id).not.toBe('')
  })

  it('upsertRemoteLesson 幂等、不再回传、可补确认', () => {
    const { taskId } = setup()
    const input = { id: 'lsn_remote1', anchorRef: 'lin_decode', symptom: '远处的坑', fixMd: '修法', authorName: 'laowang', localAuthorId: me, createdAt: Date.now() }
    const first = store.upsertRemoteLesson(input)!
    expect(first.authorName).toBe('laowang')
    expect(store.listLessonsToUpload()).toHaveLength(0) // 上传标记已置 1

    // 同 id 再来一次（重放）不重复；确认状态补上
    const again = store.upsertRemoteLesson({ ...input, confirmed: true })!
    expect(again.id).toBe(first.id)
    expect(store.lessonById(first.id)!.confirmedAt).not.toBeNull()
  })

  it('驳回后降回 personal，不再当团队坑', () => {
    const remote = store.upsertRemoteLesson({ id: 'lsn_r2', anchorRef: 'lin_x', symptom: 's', fixMd: 'f', authorName: 'b', localAuthorId: me, createdAt: Date.now() })!
    store.setRemoteLessonStatus(remote.id, 'declined')
    expect(store.lessonById(remote.id)!.scope).toBe('personal')
  })

  it('两次没帮上且从没帮上 → 疑似过期；帮上一次就解除', () => {
    const { taskId } = setup()
    const l = store.createLesson({ anchorKind: 'step_lineage', anchorRef: 'lin_decode', symptom: 's', fixMd: 'f', authorId: me, sourceTaskId: taskId })

    store.recordLessonMiss(l.id)
    expect(store.lessonById(l.id)!.staleAt).toBeNull()
    store.recordLessonMiss(l.id)
    expect(store.lessonById(l.id)!.staleAt).not.toBeNull()

    store.recordLessonHit(l.id)
    expect(store.lessonById(l.id)!.staleAt).toBeNull()
    expect(store.lessonById(l.id)!.hitCount).toBe(1)
  })

  it('searchLessons 不再返回疑似过期的（起草用不到过时坑）', () => {
    const { taskId } = setup()
    const l = store.createLesson({ anchorKind: 'free', symptom: '过时的坑', fixMd: 'f', authorId: me, sourceTaskId: taskId })
    store.recordLessonMiss(l.id)
    store.recordLessonMiss(l.id)
    expect(store.searchLessons('过时', 10)).toHaveLength(0)
  })
})

describe('捕获提议（M9）', () => {
  it('dedupKey 跨状态唯一——处理过的不再复活（底稿提议从团队全量重发）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    expect(store.createLessonOffer({ taskId: t.id, kind: 'question', payload: { questionId: 'q1' }, dedupKey: 'q1' })).toBe(true)
    expect(store.createLessonOffer({ taskId: t.id, kind: 'question', payload: { questionId: 'q1' }, dedupKey: 'q1' })).toBe(false)

    const offers = store.listLessonOffers(t.id)
    expect(offers).toHaveLength(1)
    store.setLessonOfferStatus(offers[0]!.id, 'dismissed')
    expect(store.listLessonOffers(t.id)).toHaveLength(0)

    // dismissed 之后同 dedupKey 不再问（fix 的 dedup 含 rev，新编辑=新 key，不受影响）
    expect(store.createLessonOffer({ taskId: t.id, kind: 'question', payload: { questionId: 'q1' }, dedupKey: 'q1' })).toBe(false)
    expect(store.createLessonOffer({ taskId: t.id, kind: 'question', payload: { questionId: 'q2' }, dedupKey: 'q2' })).toBe(true)
  })

  it('按 dedupKey 任意状态查提议（下行通知精确落任务）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    store.createLessonOffer({ taskId: t.id, kind: 'proposal', payload: { remoteId: 'prp_1' }, dedupKey: 'prp:prp_1' })
    const found = store.findLessonOfferByDedup('proposal', 'prp:prp_1')
    expect(found?.taskId).toBe(t.id)
    expect(store.findLessonOfferByDedup('proposal', 'prp:none')).toBeNull()
  })

  it('按步骤取 pending 提议；payload 可打补丁', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: 's', command: 'echo' }] })
    store.createLessonOffer({ taskId: t.id, stepId: steps[0]!.id, kind: 'fix', payload: { before: 'a' } })

    const at = store.pendingOffersForStep(steps[0]!.id)
    expect(at).toHaveLength(1)
    store.patchLessonOfferPayload(at[0]!.id, { remoteId: 'prp_1' })
    expect(store.lessonOfferById(at[0]!.id)!.payload).toEqual({ before: 'a', remoteId: 'prp_1' })
  })
})

describe('share_output 落库（审查修复回归）', () => {
  it('PATCH 更新 shareOutput 真的写进库里（此前 SET 列缺失，永远不生效）', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: 's', command: 'echo x' }] })
    const step = steps[0]!
    const updated = store.updateStep(step.id, { shareOutput: true }, { expectedRev: step.rev, actorId: me })
    expect(updated.step.shareOutput).toBe(true)
    expect(store.getStep(step.id)!.shareOutput).toBe(true)
    // 关掉也生效
    const again = store.updateStep(updated.step.id, { shareOutput: false }, { expectedRev: updated.step.rev, actorId: me })
    expect(store.getStep(step.id)!.shareOutput).toBe(false)
  })
})
