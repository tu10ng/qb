import { describe, expect, it } from 'vitest'
import { createApp } from '../src/api.ts'
import { openDb } from '../src/db.ts'
import { TeamStore, type SyncPush } from '../src/store.ts'
import { channelWants, inQuietHours } from '../src/push.ts'

/** Hono 的 app.request 做进程内测试，不用真起端口。 */

function fresh() {
  const store = new TeamStore(openDb({ path: ':memory:' }))
  const app = createApp({ store })
  return { store, app }
}

/** 造执行者（引擎令牌的持有者）与发起人。 */
function setupUsers(store: TeamStore): { initiatorToken: string; engineToken: string } {
  // 先建老王：首位注册者即管理员（渠道/邀请只有他能配，测试里要用）
  const initiator = store.createUser('laowang', '老王')
  const initiatorToken = store.issueToken(initiator.id)
  const executor = store.createUser('tu10ng', '小A')
  const engineToken = store.issueToken(executor.id)
  return { initiatorToken, engineToken }
}

function pushBody(over: Partial<SyncPush> = {}): SyncPush {
  return {
    user: { name: 'tu10ng', displayName: '小A' },
    sinceDownSeq: 0,
    tasks: [
      {
        id: 'tsk_1',
        title: '在 Y 集群部署 PD 分离',
        briefMd: '',
        initiatorName: 'laowang',
        assigneeName: 'tu10ng',
        status: 'active',
        expectedMinutes: 120,
        startedAt: 1000,
        endedAt: null,
        runbookVersion: 1,
        steps: [
          { taskId: 'tsk_1', id: 's1', parentId: null, orderKey: 'V', kind: 'note', title: '1 启动', command: null, status: 'pending', expectedMinutes: null, actualMs: null, statusNote: null },
          { taskId: 'tsk_1', id: 's2', parentId: 's1', orderKey: 'k', kind: 'command', title: '起 decode', command: 'vllm serve', status: 'failed', expectedMinutes: 8, actualMs: 90000, statusNote: 'NCCL' },
        ],
      },
    ],
    events: [
      { taskId: 'tsk_1', engineSeq: 1, stepId: 's2', actorName: 'tu10ng', kind: 'step_failed', payload: { verdict: 'fail' }, createdAt: 2000 },
    ],
    alerts: [
      { key: 'fail_streak:s2', taskId: 'tsk_1', stepId: 's2', level: 'red', type: 'fail_streak', message: '「起 decode」连续失败 3 次', at: 2000 },
    ],
    questions: [],
    lessons: [],
    ...over,
  }
}

describe('认证', () => {
  it('缺令牌 401；join 造用户发令牌；错误邀请被拒', async () => {
    const { app, store } = fresh()
    expect((await app.request('/api/overview')).status).toBe(401)

    store.createInvite(60_000)
    const invite = store.createInvite(60_000)
    const join = await app.request('/api/join', { method: 'POST', body: JSON.stringify({ invite, name: 'tester' }) })
    expect(join.status).toBe(201)
    const { token } = (await join.json()) as { token: string }
    expect((await app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await app.request('/api/join', { method: 'POST', body: JSON.stringify({ invite: 'bad', name: 'x' }) })).status).toBe(400)
  })
})

describe('引擎同步的写者校验', () => {
  it('推送身份与令牌不一致 → 403', async () => {
    const { app, store } = fresh()
    const { engineToken } = setupUsers(store)
    const H = { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' }
    const r = await app.request('/api/sync/push', {
      method: 'POST',
      headers: H,
      body: JSON.stringify(pushBody({ user: { name: 'laowang', displayName: '老王' } })),
    })
    expect(r.status).toBe(403)
  })
})

describe('引擎同步', () => {
  it('推快照 + 事件 + 告警；重推幂等；条件消失告警解除；复发重新通知', async () => {
    const { app, store } = fresh()
    const { initiatorToken, engineToken } = setupUsers(store)
    const H = { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' }

    const r1 = (await (await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody()) })).json()) as { newRedAlerts: unknown[] }
    expect(r1.newRedAlerts).toHaveLength(1)

    // 重推同一批（重试场景）：不再产生新红告警，事件不重复
    const r2 = (await (await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody()) })).json()) as { newRedAlerts: unknown[] }
    expect(r2.newRedAlerts).toHaveLength(0)
    expect(store.eventsOf('tsk_1')).toHaveLength(1)

    // 条件消失（决策集为空）→ 告警解除
    await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody({ alerts: [] })) })
    expect(store.alertsOf('tsk_1', true).every((a) => a.status === 'resolved')).toBe(true)

    // 复发：解除过的再出现 → 重新 open 且算新红告警
    const r3 = (await (await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody()) })).json()) as { newRedAlerts: unknown[] }
    expect(r3.newRedAlerts).toHaveLength(1)

    // 发起人视角能看到任务与红告警
    const overview = (await (await app.request('/api/overview', { headers: { authorization: `Bearer ${initiatorToken}` } })).json()) as {
      initiated: Array<{ id: string; total: number; done: number; worstAlert: string | null }>
    }
    expect(overview.initiated[0]).toMatchObject({ id: 'tsk_1', total: 1, done: 0, worstAlert: 'red' })
  })

  it('步骤镜像按树序读回', async () => {
    const { app, store } = fresh()
    const { engineToken } = setupUsers(store)
    await app.request('/api/sync/push', { method: 'POST', headers: { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' }, body: JSON.stringify(pushBody()) })
    expect(store.stepsOf('tsk_1').map((s) => s.title)).toEqual(['1 启动', '起 decode'])
  })
})

describe('评论 / 回答 / 已读的下行回流', () => {
  it('评论与回答带 down_seq；引擎按游标增量拉；ack 回流', async () => {
    const { app, store } = fresh()
    const { initiatorToken, engineToken } = setupUsers(store)
    const H = { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' }
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        ...pushBody(),
        questions: [{ id: 'qst_1', taskId: 'tsk_1', stepId: 's2', body: 'Y 集群 hostname 是什么？', createdAt: 3000 }],
      }),
    })

    const IH = { authorization: `Bearer ${initiatorToken}`, 'content-type': 'application/json' }
    expect((await app.request('/api/tasks/tsk_1/comments', { method: 'POST', headers: IH, body: JSON.stringify({ body: '看下 NCCL_SOCKET_IFNAME' }) })).status).toBe(201)
    expect((await app.request('/api/questions/qst_1/answer', { method: 'POST', headers: IH, body: JSON.stringify({ answer: 'gpu-21 / gpu-22' }) })).status).toBe(200)
    expect((await app.request('/api/alerts/fail_streak:s2/ack', { method: 'POST', headers: IH })).status).toBe(200)

    const r = (await (await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody({ sinceDownSeq: 0, alerts: [] })) })).json()) as {
      down: Array<{ kind: string }>
      lastDownSeq: number
    }
    expect(r.down.map((d) => d.kind).sort()).toEqual(['ack', 'answer', 'comment'])

    // 游标前进后再推：没有重复下行
    const r2 = (await (await app.request('/api/sync/push', { method: 'POST', headers: H, body: JSON.stringify(pushBody({ sinceDownSeq: r.lastDownSeq, alerts: [] })) })).json()) as { down: unknown[] }
    expect(r2.down).toEqual([])
  })
})

describe('推送渠道', () => {
  it('CRUD + 校验：webhook 缺 url 拒绝', async () => {
    const { app, store } = fresh()
    const { initiatorToken } = setupUsers(store)
    const H = { authorization: `Bearer ${initiatorToken}`, 'content-type': 'application/json' }

    const bad = await app.request('/api/push/channels', { method: 'POST', headers: H, body: JSON.stringify({ name: 'IM', kind: 'webhook', config: {} }) })
    expect(bad.status).toBe(400)

    const okRes = await app.request('/api/push/channels', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: '企业微信机器人', kind: 'webhook', config: { url: 'https://example.com/hook' } }),
    })
    expect(okRes.status).toBe(201)
    const { channel } = (await okRes.json()) as { channel: { id: string } }

    const pyRes = await app.request('/api/push/channels', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Python 脚本', kind: 'command', config: { command: 'python push.py' } }),
    })
    expect(pyRes.status).toBe(201)

    expect(store.listChannels()).toHaveLength(2)
    expect((await app.request(`/api/push/channels/${channel.id}`, { method: 'DELETE', headers: H })).status).toBe(200)
    expect(store.listChannels()).toHaveLength(1)
  })

  it('command 渠道真的会执行：echo 脚本吃 JSON stdin 与 QB_ALERT_TEXT', async () => {
    const { store } = fresh()
    const channel = store.saveChannel({
      name: 'echo',
      kind: 'command',
      // stdin 的 JSON 原样回显；Windows 与 Linux 都有的命令
      config: { command: process.platform === 'win32' ? 'findstr x' : 'cat' },
      minLevel: 'red',
      enabled: true,
    })
    // findstr x 会输出含 x 的行（我们的 JSON 一定含）；cat 全量回显
    const outcome = await new Promise((resolve) => {
      // 直接测 pushCommand 的等价路径：走 testChannel
      void import('../src/push.ts').then(async (m) => resolve(await m.testChannel(channel)))
    }) as { ok: boolean; detail: string }
    expect(outcome.ok).toBe(true)
  })
})

describe('免打扰与渠道过滤', () => {
  it('跨零点的免打扰时段；渠道按级别过滤', () => {
    expect(inQuietHours(new Date('2026-01-01T23:30:00'), { start: '22:00', end: '08:00', enabled: true })).toBe(true)
    expect(inQuietHours(new Date('2026-01-01T12:00:00'), { start: '22:00', end: '08:00', enabled: true })).toBe(false)
    expect(inQuietHours(new Date('2026-01-01T12:00:00'), { start: '22:00', end: '08:00', enabled: false })).toBe(false)

    expect(channelWants({ enabled: true, minLevel: 'red' } as never, { level: 'red' } as never)).toBe(true)
    expect(channelWants({ enabled: true, minLevel: 'red' } as never, { level: 'yellow' } as never)).toBe(false)
    expect(channelWants({ enabled: true, minLevel: 'yellow' } as never, { level: 'yellow' } as never)).toBe(true)
  })
})

describe('坑库与底稿提议（M9）', () => {
  const linSteps = [
    { taskId: 'tsk_1', id: 's1', parentId: null, orderKey: 'V', kind: 'note', title: '1 启动', command: null, status: 'pending', expectedMinutes: null, actualMs: null, statusNote: null, lineageKey: null },
    { taskId: 'tsk_1', id: 's2', parentId: 's1', orderKey: 'k', kind: 'command', title: '起 decode', command: 'vllm serve', status: 'failed', expectedMinutes: 8, actualMs: 90000, statusNote: null, lineageKey: 'lin_decode' },
  ]

  function withLineage(): SyncPush {
    return pushBody({ tasks: [{ ...pushBody().tasks[0]!, steps: linSteps }] })
  }

  function lessonPush(over: Partial<SyncPush> = {}): SyncPush {
    return {
      ...withLineage(),
      lessons: [
        {
          id: 'lsn_1',
          lineageKey: 'lin_decode',
          symptom: 'No route to host',
          cause: 'NCCL 走了 docker0',
          fixMd: 'export NCCL_SOCKET_IFNAME=eth0',
          condition: 'DECODE_HOST == gpu-18',
          taskId: 'tsk_1',
          taskTitle: '在 Y 集群部署 PD 分离',
          createdAt: 3000,
        },
      ],
      ...over,
    }
  }

  it('上传的坑：给同血缘其他执行者排下行；发起人拿到 🟡 待确认告警；作者不收回自己的', () => {
    const { store, app } = fresh()
    setupUsers(store)
    // 第二位执行者小B，也在做同血缘的步骤
    const b = store.createUser('xiaob', '小B')
    store.issueToken(b.id)
    store.ingestPush(
      pushBody({
        tasks: [
          {
            id: 'tsk_2',
            title: '小B 的 Y 集群',
            briefMd: '',
            initiatorName: 'laowang',
            assigneeName: 'xiaob',
            status: 'active',
            expectedMinutes: 60,
            startedAt: null,
            endedAt: null,
            runbookVersion: 1,
            steps: linSteps.map((s) => ({ ...s, taskId: 'tsk_2' })),
          },
        ],
        events: [],
        alerts: [],
      }),
    )

    // 走 store 直测（ingestPush 与 API 路径等价）
    const result = store.ingestPush(lessonPush())

    // 发起人视角：黄告警出现
    const alerts = store.openAlertsForUser('laowang')
    expect(alerts.some((a) => a.type === 'lesson_pending' && a.taskId === 'tsk_1')).toBe(true)

    // 作者（小A）不收回自己的坑；小B 的下行里有它
    expect(result.down.filter((d) => d.kind === 'lesson')).toHaveLength(0)
    const bDown = store.ingestPush(pushBody({
      user: { name: 'xiaob', displayName: '小B' },
      tasks: [{ id: 'tsk_2', title: '小B 的 Y 集群', briefMd: '', initiatorName: 'laowang', assigneeName: 'xiaob', status: 'active', expectedMinutes: 60, startedAt: null, endedAt: null, runbookVersion: 1, steps: linSteps.map((s) => ({ ...s, taskId: 'tsk_2' })) }],
      events: [], alerts: [], questions: [], lessons: [],
      sinceDownSeq: 0,
    }))
    const lessonDown = bDown.down.filter((d) => d.kind === 'lesson')
    expect(lessonDown).toHaveLength(1)
    expect((lessonDown[0]!.payload as { lineageKey: string }).lineageKey).toBe('lin_decode')
  })

  it('重推同一个坑幂等；确认后告警解除、作者收到通知、再确认被拒', async () => {
    const { store, app } = fresh()
    const { initiatorToken, engineToken } = setupUsers(store)
    store.ingestPush(lessonPush())
    store.ingestPush(lessonPush()) // 重推：不重复

    expect(store.openAlertsForUser('laowang').filter((a) => a.type === 'lesson_pending')).toHaveLength(1)

    // 非发起人不能确认
    const denied = await app.request('/api/lessons/lsn_1/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    })
    expect(denied.status).toBe(403)

    // 发起人（管理员）确认
    const ok = await app.request('/api/lessons/lsn_1/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${initiatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    })
    expect(ok.status).toBe(200)
    expect(store.openAlertsForUser('laowang').filter((a) => a.type === 'lesson_pending')).toHaveLength(0)
    expect(store.lessonById('lsn_1')!.status).toBe('confirmed')

    // 作者拉下行：拿到确认状态
    const mine = store.ingestPush(lessonPush())
    const status = mine.down.filter((d) => d.kind === 'lesson_status')
    expect(status).toHaveLength(1)
    expect((status[0]!.payload as { status: string }).status).toBe('confirmed')

    // 重复确认 → 409
    const again = await app.request('/api/lessons/lsn_1/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${initiatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: false }),
    })
    expect(again.status).toBe(409)
  })

  it('底稿提议：创建 → 有同血缘的执行者收到 → 裁定后提议人收到通知', async () => {
    const { store, app } = fresh()
    setupUsers(store)
    store.ingestPush(withLineage())

    const created = await app.request('/api/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${store.issueToken(store.userByName('tu10ng')!.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ lineageKey: 'lin_decode', stepTitle: '起 decode', beforeMd: 'vllm serve', afterMd: 'NCCL_SOCKET_IFNAME=eth0 vllm serve', fromTaskId: 'tsk_1', fromTaskTitle: '在 Y 集群部署 PD 分离' }),
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    // 小A 自己不该收到自己的提议；先把小A 的游标推过去
    store.ingestPush(withLineage())
    // 小B 在做同血缘 → 下行里有提议
    const bDown = store.ingestPush(pushBody({
      user: { name: 'xiaob', displayName: '小B' },
      tasks: [{ id: 'tsk_2', title: '小B 的', briefMd: '', initiatorName: 'laowang', assigneeName: 'xiaob', status: 'active', expectedMinutes: null, startedAt: null, endedAt: null, runbookVersion: 1, steps: linSteps.map((s) => ({ ...s, taskId: 'tsk_2' })) }],
      events: [], alerts: [], questions: [], lessons: [], sinceDownSeq: 0,
    }))
    const proposals = bDown.down.filter((d) => d.kind === 'proposal')
    expect(proposals).toHaveLength(1)

    // 小B 接受 → 小A 收到通知
    const decided = await app.request(`/api/proposals/${id}/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${store.issueToken(store.userByName('xiaob')!.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'accepted' }),
    })
    expect(decided.status).toBe(200)

    const aDown = store.ingestPush(withLineage())
    const notice = aDown.down.filter((d) => d.kind === 'proposal_status')
    expect(notice).toHaveLength(1)
    expect((notice[0]!.payload as { status: string }).status).toBe('accepted')
  })
})
