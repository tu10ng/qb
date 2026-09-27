/**
 * M8 端到端：实时同步给 PL（从 .spike/e2e-m8.mjs 移过来，不再依赖 3080 上的开发实例）。
 *
 *   引擎配置团队 → 同一步失败 3 次 → 发起人看到红告警 → 执行者问发起人 →
 *   发起人回答 → 回答回流到执行者 → webhook 收到 🔴 → 团队服务重启期间的
 *   事件重连后补齐 → 发起人"知道了" → 执行者看到
 *
 * 用法：node scripts/e2e/m8.mjs
 */
import { createServer } from 'node:http'
import { createRun, freePort, json, sleep, wait } from './lib.mjs'

const run = createRun('m8')
const { check } = run
const hookHits = []
const hook = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    hookHits.push(b)
    res.writeHead(200)
    res.end('{}')
  })
})

try {
  const hookPort = await freePort()
  await new Promise((r) => hook.listen(hookPort, '127.0.0.1', r))
  const team = await run.startTeam(await freePort())
  const TEAM = team.url
  const pl = (await json(TEAM, '/api/join', 'POST', { invite: team.invite, name: 'laowang' })).body
  const me = (await json(TEAM, '/api/join', 'POST', { invite: team.invite, name: 'tu10ng' })).body
  check('发起人与执行者通过邀请注册', pl?.token && me?.token)

  // 渠道要在告警出现之前配好（已打开的告警不会向新渠道补推）
  const ch = await json(TEAM, '/api/push/channels', 'POST', { name: '本地测试', kind: 'webhook', config: { url: `http://127.0.0.1:${hookPort}/hook` }, minLevel: 'red', enabled: true }, pl.token)
  check('发起人配好 webhook 渠道', ch.status === 201, ch.body)
  const t = await json(TEAM, '/api/push/test', 'POST', { id: ch.body?.channel?.id }, pl.token)
  check('webhook 渠道直连可达（测试按钮）', t.status === 200 && t.body?.ok === true, t.body)

  const E = await run.startEngine('engine', await freePort(), 'tu10ng')
  const cfg = await json(E, '/settings/team', 'POST', { url: TEAM, token: me.token, enabled: true })
  check('引擎配置团队并启用', cfg.status === 200 && cfg.body?.enabled === true, cfg.body)

  const task = (await json(E, '/tasks', 'POST', { title: 'M8 端到端：Y 集群 PD 分离', initiatorName: 'laowang' })).body
  const rb = (await json(E, `/tasks/${task.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '起 decode', command: 'echo decode', expectedMinutes: 5 }] })).body
  const step = rb.steps[0]
  const failThrice = async (note) => {
    for (let i = 0; i < 3; i++) {
      await json(E, `/steps/${step.id}/status`, 'POST', { status: 'failed', note: `${note} ${i}` })
      if (i < 2) await json(E, `/steps/${step.id}/status`, 'POST', { status: 'pending' })
    }
  }
  await failThrice('NCCL timeout')
  const red = await wait(async () => (await json(TEAM, '/api/overview', 'GET', undefined, pl.token)).body?.initiated?.some((x) => x.id === task.id && x.worstAlert === 'red'), 20_000)
  check('发起人视角：任务出现，红告警在（连续失败 3 次）', red)
  const mirror = (await json(TEAM, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body
  check('镜像里有步骤与失败原因', mirror?.steps?.some((s) => String(s.statusNote ?? '').includes('NCCL timeout')), mirror?.steps)

  // 问发起人 → 回答 → 回流
  const ask = await json(E, `/tasks/${task.id}/ask`, 'POST', { stepId: step.id, body: 'Y 集群 hostname 是什么？' })
  check('问发起人：真实发送', ask.status === 202 && ask.body?.sent === true, ask.body)
  const q = await wait(async () => (await json(TEAM, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.questions?.some((x) => /hostname/.test(x.body)), 20_000)
  check('发起人看到了求助', q)
  const qid = (await json(TEAM, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.questions?.[0]?.id
  await json(TEAM, `/api/questions/${qid}/answer`, 'POST', { answer: 'gpu-21 / gpu-22' }, pl.token)
  const back = await wait(async () => ((await json(E, `/tasks/${task.id}/runbook`, 'GET')).body?.events ?? []).some((e) => e.kind === 'question_answered' && JSON.stringify(e.payload).includes('gpu-21')), 20_000)
  check('回答回流到执行者的事件流', back)

  // 复发：先跑通（决策消失 → 解除），再连败 3 次（重新 open → 重新推送）
  await json(E, `/steps/${step.id}/status`, 'POST', { status: 'ok' })
  await sleep(3000)
  await failThrice('again')
  const got = await wait(() => hookHits.some((h) => h.includes('连续失败')), 20_000)
  check('webhook 收到 🔴 告警（含可显示文本）', got, hookHits.slice(-2))

  // 断网续传：团队服务停掉期间产生的事件，重新起来后补齐
  const marker = (await json(E, '/tasks', 'POST', { title: 'M8 断网标记任务', initiatorName: 'laowang' })).body
  await team.stop()
  await json(E, `/tasks/${marker.id}/runbook`, 'POST', { steps: [{ kind: 'command', title: '断网中的步骤', command: 'echo x' }] })
  await sleep(3000) // 让引擎推几拍、失败几拍
  const offline = (await json(E, '/settings/team', 'GET')).body?.status
  check('断网时设置页如实显示同步失败（原先无条件显示"同步中"）', offline?.ok === false, offline)
  await team.start()
  const resynced = await wait(async () => (await json(TEAM, `/api/tasks/${marker.id}`, 'GET', undefined, pl.token)).body?.steps?.some((s) => s.title === '断网中的步骤'), 30_000)
  check('断网期间的事件重连后补齐', resynced)

  // 已读
  const openKey = (await json(TEAM, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.alerts?.find((a) => a.status === 'open')?.key
  const ack = await json(TEAM, `/api/alerts/${encodeURIComponent(openKey)}/ack`, 'POST', undefined, pl.token)
  check('发起人点了"知道了"', ack.status === 200, ack.body)
  const acked = await wait(async () => ((await json(E, `/tasks/${task.id}/runbook`, 'GET')).body?.events ?? []).some((e) => e.kind === 'alert_acked'), 20_000)
  check('执行者看到"发起人知道了"', acked)
} catch (e) {
  console.log(run.tail(30))
  console.log(e)
  check('脚本没有异常退出', false, e instanceof Error ? e.message : String(e))
} finally {
  hook.close()
  const failed = await run.finish()
  process.exit(failed === 0 ? 0 : 1)
}
