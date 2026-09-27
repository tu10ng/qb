import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '@qb/store'
import { Store } from '@qb/store'
import { detectDeviationOffer, detectFixOffer, fixCommandOf } from '../src/agent/capture.ts'

let store: Store
let me: string

beforeEach(() => {
  store = new Store(openDb({ path: ':memory:' }))
  me = store.ensureUser('tu10ng').id
})

function setup(): { taskId: string; stepId: string } {
  const t = store.createTask({ title: 'Y 集群', initiatorId: me })
  const { steps } = store.createRunbook({
    taskId: t.id,
    createdBy: me,
    steps: [
      { kind: 'command', title: '起 decode', command: 'vllm serve', lineageKey: 'lin_dec' },
    ],
  })
  return { taskId: t.id, stepId: steps[0]!.id }
}

describe('失败后修好的检测（捕获时机 1）', () => {
  it('失败 → 改命令 → 跑通：提议记坑，症状取失败输出尾部，修法是 diff', () => {
    const { taskId, stepId } = setup()
    const step = store.getStep(stepId)!

    // 失败：事件 + 证据
    store.updateStepStatus(stepId, 'failed', { endedAt: 1, startedAt: 0 })
    store.addEvidence({ stepId, source: 'auto', text: 'downloading…\nNCCL WARN No route to host', exitCode: 1 })
    store.appendEvent({ taskId, stepId, actorId: me, kind: 'step_failed', payload: { verdict: 'fail' } })

    // 改命令
    store.updateStep(stepId, { command: 'NCCL_SOCKET_IFNAME=eth0 vllm serve' }, { expectedRev: step.rev, actorId: me })
    store.appendEvent({
      taskId, stepId, actorId: me, kind: 'edit',
      payload: { changes: [{ field: 'command', before: 'vllm serve', after: 'NCCL_SOCKET_IFNAME=eth0 vllm serve' }] },
    })

    // 跑通（真实流程里 startedAt 是本次运行开始的时刻，在失败证据之后）
    store.updateStepStatus(stepId, 'running', { startedAt: Date.now() + 10 })
    store.updateStepStatus(stepId, 'ok', { endedAt: Date.now() + 20 })
    store.appendEvent({ taskId, stepId, actorId: me, kind: 'step_ok', payload: {} })

    detectFixOffer(store, taskId, stepId)

    const offers = store.listLessonOffers(taskId)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.kind).toBe('fix')
    expect(String(offers[0]!.payload.symptom)).toContain('No route to host')
    expect(offers[0]!.payload.before).toBe('vllm serve')
    expect(offers[0]!.payload.after).toBe('NCCL_SOCKET_IFNAME=eth0 vllm serve')
    // 同一 rev 不重复问
    detectFixOffer(store, taskId, stepId)
    expect(store.listLessonOffers(taskId)).toHaveLength(1)
  })

  it('失败后没改命令 → 不提议', () => {
    const { taskId, stepId } = setup()
    store.appendEvent({ taskId, stepId, actorId: me, kind: 'step_failed', payload: {} })
    store.appendEvent({ taskId, stepId, actorId: me, kind: 'step_ok', payload: {} })
    detectFixOffer(store, taskId, stepId)
    expect(store.listLessonOffers(taskId)).toHaveLength(0)
  })

  it('没失败过 → 不提议', () => {
    const { taskId, stepId } = setup()
    const step = store.getStep(stepId)!
    store.updateStep(stepId, { command: 'echo 1' }, { expectedRev: step.rev, actorId: me })
    store.appendEvent({ taskId, stepId, actorId: me, kind: 'step_ok', payload: {} })
    detectFixOffer(store, taskId, stepId)
    expect(store.listLessonOffers(taskId)).toHaveLength(0)
  })
})

describe('偏离底稿的检测（捕获时机 3）', () => {
  it('复制底稿后改命令 → 提议带回', () => {
    const base = store.createTask({ title: '底稿任务', initiatorId: me })
    const baseRb = store.createRunbook({
      taskId: base.id, createdBy: me,
      steps: [{ kind: 'command', title: '起 decode', command: 'vllm serve', lineageKey: 'lin_base' }],
    })

    const t = store.createTask({ title: '这次的任务', initiatorId: me })
    const copied = store.copyRunbook(baseRb.runbook.id, t.id, me)
    const copiedStep = copied.steps[0]!

    // 真实流程是先 updateStep 再检测（api-edit 的 PATCH 钩子）
    store.updateStep(
      copiedStep.id,
      { command: 'NCCL_SOCKET_IFNAME=eth0 vllm serve' },
      { expectedRev: copiedStep.rev, actorId: me },
    )
    detectDeviationOffer(store, t.id, copiedStep.id, 'vllm serve', 'NCCL_SOCKET_IFNAME=eth0 vllm serve')

    const offers = store.listLessonOffers(t.id)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.kind).toBe('deviation')
    expect(offers[0]!.payload.before).toBe('vllm serve')
  })

  it('改回与底稿一致 → 不提议', () => {
    const base = store.createTask({ title: '底稿任务', initiatorId: me })
    const baseRb = store.createRunbook({
      taskId: base.id, createdBy: me,
      steps: [{ kind: 'command', title: '起 decode', command: 'vllm serve', lineageKey: 'lin_b2' }],
    })
    const t = store.createTask({ title: '这次的任务', initiatorId: me })
    const copied = store.copyRunbook(baseRb.runbook.id, t.id, me)
    detectDeviationOffer(store, t.id, copied.steps[0]!.id, 'vllm serve', 'vllm serve')
    expect(store.listLessonOffers(t.id)).toHaveLength(0)
  })
})

describe('修法里抽命令', () => {
  it('围栏代码块优先；没有围栏就当整段是命令', () => {
    expect(fixCommandOf('先改网卡：\n```bash\nexport NCCL_SOCKET_IFNAME=eth0\n```\n然后重跑')).toBe('export NCCL_SOCKET_IFNAME=eth0')
    expect(fixCommandOf('export X=1')).toBe('export X=1')
    expect(fixCommandOf('```\n```')).toBeNull()
  })
})
