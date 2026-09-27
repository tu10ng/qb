/**
 * Phase 0 修的断链（见 plans 与测试手册的"功能真相表"）：
 * - 起草产出参数（原先只写 assumptions，参数面板不出现 → 死路）
 * - wait 步骤真的盯着就绪条件（原先 pollReadiness 没人调用）
 * - 委派进度按父步骤回流、对方完成则这一步完成（原先一条都没回来过）
 * - 派来的任务归本机执行者（原先执行者默认成了发起人，本机看不到）
 * - 评论按 commentId 去重（原先按 id 判，从没生效）
 * - 红告警第一次出现时，执行者自己的时间线记一条"QB 告诉了谁"
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from '@qb/store'
import { draftParams, draftRunbook, type DraftContext } from '../src/agent/draft.ts'
import { runWaitStep } from '../src/runner/wait-step.ts'
import { tcpProbe } from '../src/runner/readiness.ts'
import { createSync, TeamSettings } from '../src/sync/sync.ts'
import { FakeHost } from './fake-host.ts'
import { FakeLlm } from './fake-llm.ts'

let store: Store
let me: string

beforeEach(() => {
  store = new Store(openDb({ path: ':memory:' }))
  me = store.ensureUser('tu10ng').id
})

// ── 起草参数 ───────────────────────────────────────────────

const ctx: DraftContext = {
  task: { title: '部署 vLLM', briefMd: 'PD 分离', expectedMinutes: null, definitionOfDone: null },
  environments: [],
  skills: [],
  lessons: [],
}

describe('起草产出参数', () => {
  it('模型声明的参数规整成大写下划线；命令里用到却没声明的补上空值', async () => {
    const llm = new FakeLlm({
      params: [{ name: 'decode host', value: 'gpu-17', description: 'decode 节点' }, { name: 'DECODE_HOST', value: 'dup' }],
      assumptions: [{ key: '做法', value: 'nohup 前台拉起' }],
      steps: [
        { section: '1', kind: 'command', title: '登录', command: 'ssh {{DECODE_HOST}} hostname' },
        { section: '1', kind: 'command', title: '起 decode', command: 'CUDA_VISIBLE_DEVICES={{DECODE_GPUS}} vllm serve --port {{DECODE_PORT}}' },
      ],
    })
    const r = await draftRunbook(llm, '你是 QB', '{{title}}', ctx)
    expect(r.params).toEqual([
      { name: 'DECODE_HOST', value: 'gpu-17', description: 'decode 节点' },
      { name: 'DECODE_GPUS', value: '', description: '起草时用到但没给值' },
      { name: 'DECODE_PORT', value: '', description: '起草时用到但没给值' },
    ])
    expect(r.assumptions).toEqual([{ key: '做法', value: 'nohup 前台拉起', editedByUser: false }])
  })

  it('模型没给 params 字段也不炸（宽容校验）', () => {
    expect(draftParams([], [{ command: 'echo {{X_1}}' }])).toEqual([{ name: 'X_1', value: '', description: '起草时用到但没给值' }])
  })
})

// ── wait 步骤 ─────────────────────────────────────────────

let server: Server | null = null
afterEach(async () => {
  if (server !== null) await new Promise((r) => server!.close(r))
  server = null
})

async function httpServer(status: number): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status)
    res.end('ok')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`
}

describe('wait 步骤：盯着就绪条件', () => {
  it('只盯着：health 地址返回 200 → 就绪', async () => {
    const url = await httpServer(200)
    const host = new FakeHost()
    const h = runWaitStep(host, { command: null, probe: { kind: 'http', url, expectStatus: 200 }, timeoutMs: 5000 })
    const o = await h.outcome
    expect(o.ready).toBe(true)
    expect(o.detail).toContain('返回 200')
    expect(host.calls).toHaveLength(0) // 只盯着不起任何命令
  })

  it('运行并盯着：命令非 0 退出且还没就绪 → 失败，带上退出码', async () => {
    const host = new FakeHost()
    host.setScript([{ exitCode: 1, chunks: ['Address already in use\n'] }])
    const h = runWaitStep(host, { command: 'vllm serve', probe: { kind: 'port', host: '127.0.0.1', port: 1 }, timeoutMs: 60_000 })
    const o = await h.outcome
    expect(o.ready).toBe(false)
    expect(o.detail).toContain('退出码 1')
    expect(o.output).toContain('Address already in use')
  })

  it('日志模式：输出里出现字样即就绪；只盯着时拒绝日志模式', async () => {
    const host = new FakeHost()
    host.setScript([{ exitCode: 0, chunks: ['loading\n', 'INFO Started server process\n'] }])
    const h = runWaitStep(host, { command: 'vllm serve', probe: { kind: 'logPattern', pattern: 'Started server' }, timeoutMs: 60_000 })
    expect((await h.outcome).ready).toBe(true)
    expect(() => runWaitStep(host, { command: null, probe: { kind: 'logPattern', pattern: 'x' }, timeoutMs: 1000 })).toThrow(/只盯着用不了/)
  })

  it('取消会结束等待（日志模式没有轮询循环也要能收尾）', async () => {
    const host = new FakeHost()
    host.setScript([{ exitCode: 0, chunks: [] }])
    const h = runWaitStep(host, { command: 'sleep 100', probe: { kind: 'logPattern', pattern: 'never' }, timeoutMs: 60_000 })
    h.cancel()
    const o = await h.outcome
    expect(o).toMatchObject({ ready: false, cancelled: true, detail: '已取消' })
  })

  it('端口探测走 TCP：开着的端口连得上，关着的连不上', async () => {
    const url = await httpServer(200)
    const port = Number(new URL(url).port)
    expect(await tcpProbe('127.0.0.1', port, 2000)).toBe(true)
    await new Promise((r) => server!.close(r))
    server = null
    expect(await tcpProbe('127.0.0.1', port, 2000)).toBe(false)
  })
})

// ── 同步：下行落地 ─────────────────────────────────────────

function sync() {
  return createSync({ store, userName: () => 'tu10ng', currentUserId: () => me, broadcast: () => undefined, log: () => undefined })
}

describe('委派进度回流（sync.applyDown）', () => {
  function delegated() {
    const t = store.createTask({ title: '上线', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'delegate', title: '→ 小B: 压测' }] })
    store.createDelegation({ stepId: steps[0]!.id, teamTaskId: 'tsk_child', assigneeName: 'xiaob' })
    return { taskId: t.id, stepId: steps[0]!.id }
  }

  it('进度到达 → 委派行更新 + 时间线；对方完成 → 这一步完成', () => {
    const { taskId, stepId } = delegated()
    const s = sync()
    s.applyDown([{ kind: 'task_progress', payload: { task_id: 'tsk_child', parent_step_id: stepId, status: 'active', done: 1, total: 3, worst_alert: 'red' } }])
    expect(store.delegationOf(stepId)).toMatchObject({ status: 'active', done: 1, total: 3, worstAlert: 'red' })
    expect(store.listEvents(taskId).some((e) => e.kind === 'delegate_progress' && e.payload.done === 1)).toBe(true)

    // 同样的进度重放：不重复记事件
    s.applyDown([{ kind: 'task_progress', payload: { task_id: 'tsk_child', parent_step_id: stepId, status: 'active', done: 1, total: 3, worst_alert: 'red' } }])
    expect(store.listEvents(taskId).filter((e) => e.kind === 'delegate_progress')).toHaveLength(1)

    s.applyDown([{ kind: 'task_progress', payload: { task_id: 'tsk_child', parent_step_id: stepId, status: 'done', done: 3, total: 3 } }])
    expect(store.getStep(stepId)!.status).toBe('ok')
    expect(store.listEvents(taskId).some((e) => e.kind === 'step_ok' && e.payload.source === 'delegate')).toBe(true)
  })

  it('对方放弃 → 这一步标失败并写明原因；不认识的父步骤忽略', () => {
    const { stepId } = delegated()
    const s = sync()
    s.applyDown([{ kind: 'task_progress', payload: { parent_step_id: 'stp_nope', status: 'done' } }])
    s.applyDown([{ kind: 'task_progress', payload: { parent_step_id: stepId, status: 'abandoned', done: 0, total: 3 } }])
    expect(store.getStep(stepId)).toMatchObject({ status: 'failed', statusNote: 'xiaob 放弃了这个任务' })
  })
})

describe('派来的任务与评论（sync.applyDown）', () => {
  it('派来的任务归本机执行者，发起人是派活的人', () => {
    sync().applyDown([{ kind: 'task', payload: { id: 'tsk_remote', title: '把 PD 跑通', brief_md: '', initiator_name: 'laowang' } }])
    const t = store.getTask('tsk_remote')!
    expect(t.assigneeId).toBe(me)
    expect(store.getUser(t.initiatorId)!.name).toBe('laowang')
    expect(store.listTasks({ assigneeId: me }).map((x) => x.id)).toContain('tsk_remote')
  })

  it('同一条评论重放不落两次；评论挂在它指定的那一步上', () => {
    const t = store.createTask({ title: 'x', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: 'a', command: 'echo' }] })
    const c = { kind: 'comment', payload: { id: 'cmt_1', task_id: t.id, step_id: steps[0]!.id, author_name: '老王', body: '看下网卡' } }
    const s = sync()
    s.applyDown([c])
    s.applyDown([c])
    const comments = store.listEvents(t.id).filter((e) => e.kind === 'comment')
    expect(comments).toHaveLength(1)
    expect(comments[0]!.stepId).toBe(steps[0]!.id)
  })
})

describe('告警的透明与静音（sync.evaluateNow）', () => {
  function failingTask() {
    const laowang = store.ensureUser('laowang', '老王')
    const t = store.createTask({ title: 'Y 集群', initiatorId: laowang.id, assigneeId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: '起 decode', command: 'x' }] })
    store.markTaskStarted(t.id, me)
    for (let i = 0; i < 3; i++) store.appendEvent({ taskId: t.id, stepId: steps[0]!.id, actorId: me, kind: 'step_failed', payload: {} })
    // 团队配置指向一个连不上的地址：推送失败无所谓，透明事件照记
    new TeamSettings(store).save({ url: 'http://127.0.0.1:9', token: 't', enabled: true, identity: { name: 'tu10ng', displayName: '小A' } })
    return t.id
  }

  it('红告警第一次出现：时间线记一条"QB 告诉了老王"；再算一遍不重复记', () => {
    const taskId = failingTask()
    const s = sync()
    s.evaluateNow()
    s.evaluateNow()
    const raised = store.listEvents(taskId).filter((e) => e.kind === 'alert_raised')
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload).toMatchObject({ type: 'fail_streak', to: '老王' })
  })

  it('静音了的告警不再算（原先 isSnoozed 从没被调用）', () => {
    const taskId = failingTask()
    const stepId = store.getLatestRunbook(taskId)!.steps[0]!.id
    store.snoozeAlert(taskId, `fail_streak:${stepId}`, me, 30)
    sync().evaluateNow()
    expect(store.listEvents(taskId).filter((e) => e.kind === 'alert_raised')).toHaveLength(0)
  })

  it('自己给自己建的任务：没告诉任何人，不记透明事件', () => {
    const t = store.createTask({ title: 'mine', initiatorId: me })
    const { steps } = store.createRunbook({ taskId: t.id, createdBy: me, steps: [{ kind: 'command', title: 'a', command: 'x' }] })
    store.markTaskStarted(t.id, me)
    for (let i = 0; i < 3; i++) store.appendEvent({ taskId: t.id, stepId: steps[0]!.id, actorId: me, kind: 'step_failed', payload: {} })
    new TeamSettings(store).save({ url: 'http://127.0.0.1:9', token: 't', enabled: true, identity: null })
    sync().evaluateNow()
    expect(store.listEvents(t.id).filter((e) => e.kind === 'alert_raised')).toHaveLength(0)
  })
})
