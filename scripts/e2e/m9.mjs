/**
 * M9 端到端：坑的闭环（从 .spike/e2e-m9.mjs 移过来），真起团队服务 + 两台引擎。
 *
 *   1. 失败 → 改命令 → 跑通 → 预填好的"记成坑？"卡片 → 记下并共享
 *   2. 另一个用户同血缘的步骤，看到第一层预警；发起人确认后状态变"已确认"
 *   3. 两次"不是这个" → 疑似过期（掉到第二层）
 *   4. 偏离底稿 → 带回底稿 → 同血缘持有者应用；驳回的坑降级
 *
 * 注意：两个人的步骤要有同一个血缘，这里是经 API 直接写入 lineageKey 的。
 * 真实使用里跨人的同血缘要等 Phase 2 的团队底稿库（从团队底稿复制才会
 * 保留血缘）——这是评估报告里记下的限制，不是这个脚本能证明的事。
 *
 * 用法：node scripts/e2e/m9.mjs
 */
import { createRun, freePort, json, sleep, wait } from './lib.mjs'

const run = createRun('m9')
const { check } = run

try {
  const team = await run.startTeam(await freePort())
  const TEAM = team.url
  const invite = team.invite
  check('团队服务已起', invite !== '')

  // 三个人：老王（发起人/管理员）、A（tu10ng）、B（xiaob）——首张邀请恰好 3 次
  const plToken = (await json(TEAM, '/api/join', 'POST', { invite, name: 'laowang' })).body?.token
  const tokenA = (await json(TEAM, '/api/join', 'POST', { invite, name: 'tu10ng' })).body?.token
  const tokenB = (await json(TEAM, '/api/join', 'POST', { invite, name: 'xiaob' })).body?.token
  check('三人注册拿令牌', plToken && tokenA && tokenB ? true : false)

  // ── 两台引擎 ──
  const A = await run.startEngine('a', await freePort(), 'tu10ng')
  const B = await run.startEngine('b', await freePort(), 'xiaob')
  check('两台引擎起来了', true)

  // 都接上团队
  await json(A, '/settings/team', 'POST', { url: TEAM, token: tokenA, enabled: true })
  await json(B, '/settings/team', 'POST', { url: TEAM, token: tokenB, enabled: true })

  // ── 验收 1：失败 → 改命令 → 跑通 → 预填卡片 → 记成坑并共享 ──
  // 用"预期包含 X + 命令不含 X"制造真失败，改命令后真跑通——走的是真
  // 执行管线（证据、事件、捕获检测全在路径上）
  const task = (await json(A, '/tasks', 'POST', { title: 'M9 端到端：Y 集群', initiatorName: 'laowang' })).body
  const rb = (await json(A, `/tasks/${task.id}/runbook`, 'POST', {
    steps: [{
      kind: 'command', title: '起 decode', command: 'echo hi', lineageKey: 'lin_m9_e2e',
      expectation: { kind: 'contains', text: 'NEVER_APPEARS', caseSensitive: true },
    }],
  })).body
  const step = rb.steps?.[0]

  const fail = await json(A, `/steps/${step.id}/run`, 'POST', {})
  check('第一次真跑（会失败）', fail.status === 202, JSON.stringify(fail.body))
  await wait(async () => (await json(A, `/tasks/${task.id}/runbook`, 'GET')).body?.steps?.[0]?.status === 'failed', 20_000)

  // 改命令：加上预期里的字样
  const rev = (await json(A, `/tasks/${task.id}/runbook`, 'GET')).body?.steps?.[0]?.rev
  await json(A, `/steps/${step.id}`, 'PATCH', { rev, command: 'echo hi NEVER_APPEARS' })

  const pass = await json(A, `/steps/${step.id}/run`, 'POST', {})
  check('改完再跑（会通过）', pass.status === 202, JSON.stringify(pass.body))
  await wait(async () => (await json(A, `/tasks/${task.id}/runbook`, 'GET')).body?.steps?.[0]?.status === 'ok', 20_000)

  // 捕获提议出现，且预填来自真实 diff
  const offers = (await json(A, `/tasks/${task.id}/lesson-offers`, 'GET')).body?.offers ?? []
  const fixOffer = offers.find((o) => o.kind === 'fix')
  check('跑通后弹出"记成坑？"（捕获提议）', fixOffer !== undefined, JSON.stringify(offers.map((o) => o.kind)))
  check(
    '预填好了修法 diff',
    fixOffer?.payload?.before === 'echo hi' && fixOffer?.payload?.after === 'echo hi NEVER_APPEARS',
    JSON.stringify(fixOffer?.payload),
  )
  check('症状预填了失败输出', String(fixOffer?.payload?.symptom ?? '').includes('hi'), JSON.stringify(fixOffer?.payload?.symptom))

  const accepted = await json(A, `/lesson-offers/${fixOffer.id}/accept`, 'POST', { scope: 'team' })
  check('记成坑并共享', accepted.status === 201 && accepted.body?.lesson?.id, JSON.stringify(accepted.body).slice(0, 160))
  const lessonId = accepted.body?.lesson?.id

  // ── 验收 2：同血缘的 B 看到第一层预警；发起人确认 ──
  const taskB = (await json(B, '/tasks', 'POST', { title: 'M9 端到端：B 的同款', initiatorName: 'laowang' })).body
  await json(B, `/tasks/${taskB.id}/runbook`, 'POST', {
    steps: [{ kind: 'command', title: '起 decode（B）', command: 'echo hi', lineageKey: 'lin_m9_e2e' }],
  })

  const bSeen = await wait(async () => {
    const lessons = (await json(B, `/tasks/${taskB.id}/lessons`, 'GET')).body?.steps ?? {}
    return Object.values(lessons).some((s) => s.layer1?.some((l) => l.id === lessonId))
  }, 20_000)
  const bLessons = (await json(B, `/tasks/${taskB.id}/lessons`, 'GET')).body?.steps ?? {}
  const bLayer1 = Object.values(bLessons).flatMap((s) => s.layer1 ?? [])
  check('B 在同血缘步骤看到第一层预警', bSeen, JSON.stringify(bLessons).slice(0, 200))
  check(
    '预警标注了作者与"未验证"',
    bLayer1.some((l) => l.id === lessonId && l.author === 'tu10ng' && l.status === 'unverified'),
    JSON.stringify(bLayer1.map((l) => [l.author, l.status])),
  )
  // B 的时间线有"谁在这一步记了个坑"（透明）
  const bDetail = await json(B, `/tasks/${taskB.id}/runbook`, 'GET')
  check(
    'B 的时间线：tu10ng 在这一步记了个坑',
    (bDetail.body?.events ?? []).some((e) => e.kind === 'lesson_shared' && e.payload?.by === 'tu10ng'),
    JSON.stringify((bDetail.body?.events ?? []).slice(-3).map((e) => e.kind)),
  )

  // 发起人（老王）确认
  const teamOverview = await json(TEAM, '/api/overview', 'GET', undefined, plToken)
  const lessonAlert = (teamOverview.body?.openAlerts ?? []).find((a) => a.type === 'lesson_pending')
  check('发起人收到 🟡 新坑待确认', lessonAlert !== undefined, JSON.stringify(teamOverview.body?.openAlerts?.map((a) => a.type)))
  const confirm = await json(TEAM, `/api/lessons/${lessonId}/confirm`, 'POST', { accept: true }, plToken)
  check('发起人确认有效', confirm.status === 200 && confirm.body?.status === 'confirmed', JSON.stringify(confirm.body).slice(0, 120))

  const aConfirmed = await wait(async () => {
    const lessons = (await json(A, `/tasks/${task.id}/lessons`, 'GET')).body?.steps ?? {}
    return Object.values(lessons).some((s) => [...(s.layer1 ?? []), ...(s.layer2 ?? [])].some((l) => l.id === lessonId && l.status === 'confirmed'))
  }, 20_000)
  check('A 的坑状态回流为"已确认"', aConfirmed)

  // ── 验收 3：B 两次"不是这个" → 疑似过期，掉到第二层 ──
  const miss1 = await json(B, `/lessons/${lessonId}/miss`, 'POST')
  const miss2 = await json(B, `/lessons/${lessonId}/miss`, 'POST')
  check('两次"不是这个"', miss1.status === 200 && miss2.status === 200 && miss2.body?.stale === true, JSON.stringify(miss2.body))

  const bAfter = (await json(B, `/tasks/${taskB.id}/lessons`, 'GET')).body?.steps ?? {}
  const bAll = Object.values(bAfter).flatMap((s) => [...(s.layer1 ?? []), ...(s.layer2 ?? [])])
  const staleLesson = bAll.find((l) => l.id === lessonId)
  check('疑似过期（标注 + 退出第一层）', staleLesson?.stale === true && Object.values(bAfter).every((s) => !(s.layer1 ?? []).some((l) => l.id === lessonId)), JSON.stringify(bAll.map((l) => [l.stale])))

  // ── 顺手：复盘清单与"按这个修" ──
  const retro = await json(A, `/tasks/${task.id}/retro`, 'GET')
  check('复盘清单可读（无待办）', retro.status === 200 && (retro.body?.offers ?? []).length === 0, JSON.stringify(retro.body?.offers))

  const apply = await json(A, `/lessons/${lessonId}/apply`, 'POST', { stepId: step.id })
  const fixStep = apply.body?.step
  check('按这个修：插入了修复步骤（挂 sourceRef）', apply.status === 201 && fixStep?.sourceRef === `lesson:${lessonId}`, JSON.stringify(apply.body).slice(0, 160))
  // 默认修法（accept 没传 fixMd）必须只含改后命令——修法抽取取最后围栏块
  check('按这个修抽到的是改后命令（不是改前）', fixStep?.command === 'echo hi NEVER_APPEARS', JSON.stringify(fixStep?.command))

  // ── 审查修复回归：偏离底稿的完整回路（A 改 → 带回 → B 应用）──
  // A 先有一份"底稿"任务，再以它为基础复制出工作副本（步骤 origin=base）
  const taskBase = (await json(A, '/tasks', 'POST', { title: 'M9 端到端：底稿源', initiatorName: 'laowang' })).body
  const rbBase = (await json(A, `/tasks/${taskBase.id}/runbook`, 'POST', {
    steps: [{ kind: 'command', title: '起 prefill', command: 'echo base', lineageKey: 'lin_m9_dev' }],
  })).body
  const taskA2 = (await json(A, '/tasks', 'POST', { title: 'M9 端到端：底稿副本', initiatorName: 'laowang' })).body
  const rbA2 = (await json(A, `/tasks/${taskA2.id}/based-on`, 'POST', { runbookId: rbBase.runbook?.id ?? rbBase.body?.runbook?.id })).body
  const taskB2 = (await json(B, '/tasks', 'POST', { title: 'M9 端到端：B 的同款底稿', initiatorName: 'laowang' })).body
  await json(B, `/tasks/${taskB2.id}/runbook`, 'POST', {
    steps: [{ kind: 'command', title: '起 prefill', command: 'echo base', lineageKey: 'lin_m9_dev' }],
  })
  await sleep(5000) // 让两边快照先到团队

  // A 改命令（触发偏离提议）→ 接受 → 发给底稿持有者
  const stepA2 = rbA2.steps?.[0]
  const revA2 = (await json(A, `/tasks/${taskA2.id}/runbook`, 'GET')).body?.steps?.[0]?.rev
  await json(A, `/steps/${stepA2.id}`, 'PATCH', { rev: revA2, command: 'echo base --fixed' })
  await sleep(800)
  const devOffers = (await json(A, `/tasks/${taskA2.id}/lesson-offers`, 'GET')).body?.offers ?? []
  const dev = devOffers.find((o) => o.kind === 'deviation')
  check('改了底稿复制来的命令 → 偏离提议出现', dev !== undefined, JSON.stringify(devOffers.map((o) => o.kind)))
  if (dev === undefined) throw new Error('偏离提议没出现，后续回路测不下去')
  const sent = await json(A, `/lesson-offers/${dev.id}/accept`, 'POST', {})
  check('带回底稿真的送出去了（此前 redact 误传对象必 502）', sent.status === 200 && sent.body?.sent === true, JSON.stringify(sent.body))

  // B 收到底稿提议 → 应用到自己手里的底稿（命令还是 before 才改）
  const bGotProposal = await wait(async () => {
    const offers = (await json(B, `/tasks/${taskB2.id}/lesson-offers`, 'GET')).body?.offers ?? []
    return offers.some((o) => o.kind === 'proposal')
  }, 20_000)
  check('B 收到底稿提议', bGotProposal)
  const bOffers = (await json(B, `/tasks/${taskB2.id}/lesson-offers`, 'GET')).body?.offers ?? []
  const bProp = bOffers.find((o) => o.kind === 'proposal')
  const applied = await json(B, `/lesson-offers/${bProp.id}/accept`, 'POST', {})
  check('B 应用提议（此前会跳过落点任务导致落空）', applied.status === 200 && applied.body?.outcome === 'accepted', JSON.stringify(applied.body))
  const bStep2 = (await json(B, `/tasks/${taskB2.id}/runbook`, 'GET')).body?.steps?.[0]
  check('B 的底稿命令真的改成了 A 的修法', bStep2?.command === 'echo base --fixed', JSON.stringify(bStep2?.command))

  // A 收到裁定通知（按提议 id 精确落任务）
  const aDecided = await wait(async () => {
    const d = await json(A, `/tasks/${taskA2.id}/runbook`, 'GET')
    return (d.body?.events ?? []).some((e) => e.kind === 'base_proposal' && e.payload?.decided === 'accepted')
  }, 20_000)
  check('A 收到底稿提议已应用的回音', aDecided)

  // ── 审查修复回归：驳回的坑不再以"未验证"传播 ──
  const declinedLesson = (await json(A, `/steps/${step.id}/lesson`, 'POST', { symptom: '会被驳回的坑 e2e', fix: 'echo whatever', scope: 'team' })).body
  check('手动记坑并共享（scope 生效，此前被硬编码 personal 丢弃）', declinedLesson?.scope === 'team', JSON.stringify(declinedLesson?.scope))
  await sleep(6000)
  const confirm2 = await json(TEAM, `/api/lessons/${declinedLesson.id}/confirm`, 'POST', { accept: false }, plToken)
  check('发起人驳回', confirm2.status === 200, JSON.stringify(confirm2.body).slice(0, 100))
  const bDeclined = await wait(async () => {
    const d = await json(B, `/tasks/${taskB.id}/runbook`, 'GET')
    return (d.body?.events ?? []).some((e) => e.kind === 'lesson_confirmed' && e.payload?.status === 'declined')
  }, 20_000).then(async () => {
    // 降级后 B 的那份坑变 personal（不再当团队坑，但还在）
    const bl = await json(B, `/tasks/${taskB.id}/lessons`, 'GET')
    const all = Object.values(bl.body?.steps ?? {}).flatMap((s) => [...(s.layer1 ?? []), ...(s.layer2 ?? [])])
    const mine = all.find((l) => l.id === declinedLesson.id)
    return mine !== undefined
  })
  check('B 手里被驳回的坑降级（不再当团队未验证坑传播）', bDeclined)

  // 断开同步
  await json(A, '/settings/team', 'POST', { url: TEAM, token: tokenA, enabled: false })
  await json(B, '/settings/team', 'POST', { url: TEAM, token: tokenB, enabled: false })
} catch (e) {
  console.log(run.tail(30))
  console.log(e)
  check('脚本没有异常退出', false, e instanceof Error ? e.message : String(e))
} finally {
  const failed = await run.finish()
  process.exit(failed === 0 ? 0 : 1)
}
