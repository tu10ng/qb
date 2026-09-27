/**
 * Phase 0 端到端：评估里发现的断链，每一条都真跑一遍。
 *
 * 真起一个团队服务 + 两台引擎（A 不设用户名、用默认的 me——验证团队
 * 身份绑定；B 是 xiaob）。老王是发起人兼管理员。
 *
 * 用法：node scripts/e2e/phase0.mjs（或 pnpm e2e）
 * UI 构建产物默认 packages/ui/dist，可用 QB_E2E_UI_DIR 指到别处。
 */
import { createServer } from 'node:http'
import { createRun, freePort, json, sleep, wait } from './lib.mjs'

const run = createRun('phase0')
const { check } = run

try {
  const team = await run.startTeam(await freePort())
  const TEAM = team.url
  check('团队服务已起，首张邀请已发', team.invite !== '')
  const home = await fetch(`${TEAM}/`).then((r) => r.text())
  const asset = /\/qb\/assets\/[^"]+\.js/.exec(home)?.[0]
  const assetType = asset !== undefined ? (await fetch(`${TEAM}${asset}`)).headers.get('content-type') ?? '' : ''
  check('团队服务的远程界面能加载脚本（原先 JS 被当成 HTML 返回 → 白屏）', assetType.includes('javascript'), assetType)

  const pl = (await json(TEAM, '/api/join', 'POST', { invite: team.invite, name: 'laowang' })).body
  const ua = (await json(TEAM, '/api/join', 'POST', { invite: team.invite, name: 'xiaoa' })).body
  const ub = (await json(TEAM, '/api/join', 'POST', { invite: team.invite, name: 'xiaob' })).body
  const PL = pl?.token
  check('三人注册（老王 / 小A / 小B）', PL && ua?.token && ub?.token)

  // A 的停滞阈值调成 3 秒、每秒重算一次，好在 e2e 里等到"卡住不动"
  const A = await run.startEngine('a', await freePort(), undefined, { QB_ALERT_STALLED_MS: '3000', QB_ALERT_EVAL_MS: '1000' })
  const B = await run.startEngine('b', await freePort(), 'xiaob', { QB_ALERT_EVAL_MS: '1000' })
  check('两台引擎起来了', true)

  // ── 1. 团队身份：本机用户是 me，推送用令牌对应的团队身份 ──────────
  const cfgA = await json(A, '/settings/team', 'POST', { url: TEAM, token: ua.token, enabled: true })
  check('A 配团队：认出团队身份 xiaoa（本机用户名是默认的 me）', cfgA.body?.identity?.name === 'xiaoa', cfgA.body)
  await json(B, '/settings/team', 'POST', { url: TEAM, token: ub.token, enabled: true })

  const t1 = (await json(A, '/tasks', 'POST', { title: 'Phase0：Y 集群 PD 分离', initiatorName: 'laowang' })).body
  const seen = await wait(async () => {
    const o = await json(TEAM, '/api/overview', 'GET', undefined, PL)
    return o.body?.initiated?.some((t) => t.id === t1.id && t.assigneeName === 'xiaoa')
  }, 20_000)
  check('发起人看到了 A 的任务，执行者记为 xiaoa（原先默认 me → 每拍 403，什么都不同步）', seen)
  const users = (await json(TEAM, '/api/users', 'GET', undefined, PL)).body?.users ?? []
  check('团队里没有冒出幽灵用户 me', !users.some((u) => u.name === 'me'), users.map((u) => u.name))
  const statusA = (await json(A, '/settings/team', 'GET')).body
  check('A 的设置页显示真实同步状态：已同步', statusA?.status?.ok === true, statusA?.status)

  // ── 2. PL 派的活，执行者本机看得到 ─────────────────────────────
  const dispatched = (await json(TEAM, '/api/dispatch', 'POST', { title: 'PL 派的活：整理压测基线', assigneeName: 'xiaoa' }, PL)).body
  const arrived = await wait(async () => ((await json(A, '/tasks', 'GET')).body?.tasks ?? []).some((t) => t.id === dispatched?.taskId), 20_000)
  check('PL 派的任务出现在执行者的任务列表里（原先执行者被记成发起人，列表里看不到）', arrived)

  // ── 3. 任务能完成：完成 → 发起人看到"完成了"、告警停止 ──────────
  const rb1 = (await json(A, `/tasks/${t1.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '起 decode', command: 'echo decode' }] })).body
  await json(A, `/steps/${rb1.steps[0].id}/status`, 'POST', { status: 'ok' })
  const done = await json(A, `/tasks/${t1.id}/status`, 'POST', { status: 'done' })
  check('完成任务（原先没有任何路径能把任务置为完成）', done.status === 200 && done.body?.task?.status === 'done', done.body)
  const plDone = await wait(async () => (await json(TEAM, `/api/tasks/${t1.id}`, 'GET', undefined, PL)).body?.task?.status === 'done', 20_000)
  check('发起人那边任务状态是"完成"', plDone)
  const retro = await json(A, `/tasks/${t1.id}/retro`, 'GET')
  check('完成后复盘清单可读', retro.status === 200)

  // ── 4. 卡住了：🔴 带原因到发起人；执行者看得到 QB 替他说了什么；静音生效 ──
  const t2 = (await json(A, '/tasks', 'POST', { title: 'Phase0：等权限', initiatorName: 'laowang' })).body
  await json(A, `/tasks/${t2.id}/runbook`, 'POST', { steps: [{ kind: 'manual', title: '申请 gpu-18 权限' }] })
  await json(A, `/tasks/${t2.id}/status`, 'POST', { status: 'blocked', note: '等 gpu-18 的权限' })
  const blockedAlert = await wait(async () => {
    const o = await json(TEAM, '/api/overview', 'GET', undefined, PL)
    return o.body?.openAlerts?.some((a) => a.taskId === t2.id && a.type === 'blocked' && a.message.includes('等 gpu-18 的权限'))
  }, 20_000)
  check('卡住了 → 发起人收到 🔴，带着原因', blockedAlert)
  const raised = await wait(async () => ((await json(A, `/tasks/${t2.id}/runbook`, 'GET')).body?.events ?? []).some((e) => e.kind === 'alert_raised' && e.payload?.key === 'blocked:task'), 10_000)
  check('执行者时间线里有"QB 替你告诉了老王"（宪法 15 的透明）', raised)
  await json(A, `/tasks/${t2.id}/alerts/snooze`, 'POST', { key: 'blocked:task', minutes: 30 })
  const snoozed = await wait(async () => {
    const o = await json(TEAM, '/api/overview', 'GET', undefined, PL)
    return !o.body?.openAlerts?.some((a) => a.taskId === t2.id && a.type === 'blocked')
  }, 20_000)
  check('"我能搞定"：静音后发起人那边的告警解除（原先静音从没生效）', snoozed)

  // ── 5. 沉默告警：失败后什么都不做，照样替他开口 ──────────────────
  const t3 = (await json(A, '/tasks', 'POST', { title: 'Phase0：失败后发呆', initiatorName: 'laowang' })).body
  const rb3 = (await json(A, `/tasks/${t3.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '起 prefill', command: 'echo prefill' }] })).body
  await json(A, `/steps/${rb3.steps[0].id}/status`, 'POST', { status: 'failed', note: 'NCCL timeout' })
  const stalled = await wait(async () => {
    const o = await json(TEAM, '/api/overview', 'GET', undefined, PL)
    return o.body?.openAlerts?.some((a) => a.taskId === t3.id && a.type === 'stalled')
  }, 25_000)
  check('失败后没有任何动作 → 发起人收到"停滞"🔴（原先没有新事件就永远不算）', stalled)

  // ── 6. 委派：派出去 → 对方收到 → 进度回流 → 对方完成则这一步完成 ──
  const t4 = (await json(A, '/tasks', 'POST', { title: 'Phase0：上线前准备', initiatorName: 'laowang' })).body
  const rb4 = (await json(A, `/tasks/${t4.id}/runbook`, 'POST', {
    steps: [
      { kind: 'command', title: '起服务', command: 'echo up' },
      { kind: 'manual', title: '压测', expectedMinutes: 30 },
    ],
  })).body
  const s2 = rb4.steps[1]
  const dg = await json(A, `/steps/${s2.id}/delegate`, 'POST', { assigneeName: 'xiaob', displayName: '小B', note: '压一下吞吐' })
  check('委派出去（经团队派活）', dg.status === 201 && typeof dg.body?.teamTaskId === 'string', dg.body)
  const childId = dg.body?.teamTaskId
  const d4 = (await json(A, `/tasks/${t4.id}/runbook`, 'GET')).body
  check('委派行记下了对方与团队任务 id；这一步变成委派', d4?.delegations?.[s2.id]?.teamTaskId === childId && d4?.steps?.[1]?.kind === 'delegate', d4?.delegations)

  const bGot = await wait(async () => ((await json(B, '/tasks', 'GET')).body?.tasks ?? []).some((t) => t.id === childId), 20_000)
  check('小B 的引擎收到了子任务（同一个 id）', bGot)
  const childRb = (await json(B, `/tasks/${childId}/runbook`, 'POST', {
    steps: [
      { kind: 'command', title: '跑压测', command: 'echo bench' },
      { kind: 'command', title: '记结果', command: 'echo record' },
    ],
  })).body
  await json(B, `/steps/${childRb.steps[0].id}/status`, 'POST', { status: 'ok' })
  const progressed = await wait(async () => {
    const d = (await json(A, `/tasks/${t4.id}/runbook`, 'GET')).body
    const del = d?.delegations?.[s2.id]
    return del?.done === 1 && del?.total === 2
  }, 25_000)
  check('委派行显示对方进度 1/2（原先进度一条都回不来）', progressed)
  await json(B, `/steps/${childRb.steps[1].id}/status`, 'POST', { status: 'ok' })
  await json(B, `/tasks/${childId}/status`, 'POST', { status: 'done' })
  const parentOk = await wait(async () => (await json(A, `/tasks/${t4.id}/runbook`, 'GET')).body?.steps?.[1]?.status === 'ok', 25_000)
  check('对方完成 → 我这一步自动完成', parentOk)
  const aOverview = (await json(TEAM, '/api/overview', 'GET', undefined, ua.token)).body
  const copies = (aOverview?.initiated ?? []).filter((t) => t.title === '压测')
  check('团队里只有一份子任务（原先委派方本机的副本会被推成幽灵任务）', copies.length === 1, copies.map((t) => [t.id, t.assigneeName]))

  // ── 7. 共享输出：打开开关后发起人看得到那一步跑出了什么 ─────────
  const t5 = (await json(A, '/tasks', 'POST', { title: 'Phase0：共享输出', initiatorName: 'laowang' })).body
  const rb5 = (await json(A, `/tasks/${t5.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '看版本', command: 'echo SHARED_OK_42' }] })).body
  const st5 = rb5.steps[0]
  await json(A, `/steps/${st5.id}`, 'PATCH', { rev: st5.rev, shareOutput: true })
  await json(A, `/steps/${st5.id}/run`, 'POST', {})
  await wait(async () => (await json(A, `/tasks/${t5.id}/runbook`, 'GET')).body?.steps?.[0]?.status !== 'running', 20_000)
  const shared = await wait(async () => {
    const m = (await json(TEAM, `/api/tasks/${t5.id}`, 'GET', undefined, PL)).body
    return String(m?.steps?.[0]?.lastOutput ?? '').includes('SHARED_OK_42')
  }, 20_000)
  check('发起人远程看到共享的输出（原先被团队 zod 剥掉）', shared)

  // ── 8. 远程对某一步评论 → 执行者那一步上看得到 ──────────────────
  await json(TEAM, `/api/tasks/${t5.id}/comments`, 'POST', { body: '版本对得上，继续', stepId: st5.id }, PL)
  const commented = await wait(async () => ((await json(A, `/tasks/${t5.id}/runbook`, 'GET')).body?.events ?? []).some((e) => e.kind === 'comment' && e.stepId === st5.id), 20_000)
  check('评论落在执行者的那一步上', commented)

  // ── 9. wait 步骤：只盯着 health 地址，就绪自动打勾 ───────────────
  const health = createServer((_q, r) => {
    r.writeHead(200)
    r.end('ok')
  })
  const hp = await freePort()
  await new Promise((r) => health.listen(hp, '127.0.0.1', r))
  try {
    const t6 = (await json(A, '/tasks', 'POST', { title: 'Phase0：等服务就绪' })).body
    const rb6 = (await json(A, `/tasks/${t6.id}/runbook`, 'POST', {
      steps: [
        { kind: 'wait', title: '等 decode 就绪', probe: { kind: 'http', url: `http://127.0.0.1:${hp}/health`, expectStatus: 200 }, timeoutMs: 30_000 },
        { kind: 'wait', title: '等一个起不来的服务', probe: { kind: 'port', host: '127.0.0.1', port: await freePort() }, timeoutMs: 3000 },
      ],
    })).body
    const w1 = await json(A, `/steps/${rb6.steps[0].id}/watch`, 'POST')
    check('只盯着：开始轮询', w1.status === 202, w1.body)
    const ready = await wait(async () => (await json(A, `/tasks/${t6.id}/runbook`, 'GET')).body?.steps?.[0]?.status === 'ok', 20_000)
    check('health 返回 200 → 这一步自动通过（原先 pollReadiness 没人调用）', ready)
    await json(A, `/steps/${rb6.steps[1].id}/watch`, 'POST')
    const gaveUp = await wait(async () => {
      const s = (await json(A, `/tasks/${t6.id}/runbook`, 'GET')).body?.steps?.[1]
      return s?.status === 'failed' && String(s?.statusNote ?? '').includes('未监听')
    }, 20_000)
    check('端口一直不通 → 超时标失败，写明最后看到了什么', gaveUp)
  } finally {
    health.close()
  }

  // ── 10. 中文找底稿 ───────────────────────────────────────────
  const t7 = (await json(A, '/tasks', 'POST', { title: '升级驱动到 550' })).body
  await json(A, `/tasks/${t7.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '看驱动', command: 'nvidia-smi' }] })
  const bases = (await json(A, `/tasks/suggest-bases?q=${encodeURIComponent('升级驱动')}`, 'GET')).body?.suggestions ?? []
  check('纯中文标题能找到底稿（原先中文检索永远不命中）', bases.some((b) => b.taskId === t7.id), bases.map((b) => b.title))

  // ── 11. 权限：不相关的人读不到别人的任务 ────────────────────────
  const peek = await json(TEAM, `/api/tasks/${t1.id}`, 'GET', undefined, ub.token)
  check('小B 读不到小A 的任务镜像（原先任何令牌都能读）', peek.status === 404, peek.status)

  await sleep(200)
} catch (e) {
  console.log('—— 日志（末尾）——')
  console.log(run.tail(40))
  console.log(e)
  check('脚本没有异常退出', false, e instanceof Error ? e.message : String(e))
} finally {
  const failed = await run.finish()
  process.exit(failed === 0 ? 0 : 1)
}
