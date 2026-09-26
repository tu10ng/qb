/**
 * 手动证据路径的端到端验证。
 *
 * 这条路径是"相信用户不当保姆"的落点：自己跑完贴回来、直接点完成，
 * 都要能正确推进状态。组合较多，容易想漏。
 */
const API = `http://127.0.0.1:${process.env.QB_PORT ?? 3080}/qb/api`

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok, detail])
}

const task = (await call('POST', '/tasks', { title: '手动证据验证' })).body

const rb = (
  await call('POST', `/tasks/${task.id}/runbook`, {
    steps: [
      {
        kind: 'command',
        title: '有预期且匹配',
        command: 'echo x',
        expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
      },
      {
        kind: 'command',
        title: '有预期但不匹配',
        command: 'echo x',
        expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
      },
      { kind: 'command', title: '无预期', command: 'echo x' },
      { kind: 'manual', title: '纯人工步骤' },
      { kind: 'command', title: '直接标完成', command: 'echo x' },
    ],
  })
).body

const [matched, mismatched, noExpect, manual, markOnly] = rb.steps

// 1. 贴的输出符合预期 → ok
let r = await call('POST', `/steps/${matched.id}/evidence`, {
  text: 'INFO Started server process [1234]',
})
check('符合预期 → ok', r.body?.status === 'ok' && r.body?.verdict === 'pass', JSON.stringify(r.body))

// 2. 贴的输出不符预期 → failed（不迁就）
r = await call('POST', `/steps/${mismatched.id}/evidence`, { text: 'Error: port in use' })
check(
  '不符预期 → failed',
  r.body?.status === 'failed' && r.body?.verdict === 'fail',
  JSON.stringify(r.body),
)

// 3. 没有预期时贴输出 → ok（贴了就说明做过了）
r = await call('POST', `/steps/${noExpect.id}/evidence`, { text: '随便什么输出' })
check('无预期贴输出 → ok', r.body?.status === 'ok', JSON.stringify(r.body))

// 4. 纯人工步骤点完成 → ok
r = await call('POST', `/steps/${manual.id}/evidence`, { markDone: true })
check('人工步骤点完成 → ok', r.body?.status === 'ok', JSON.stringify(r.body))

// 5. markDone 优先于判定：输出不符预期但用户说完成了，听用户的
r = await call('POST', `/steps/${markOnly.id}/evidence`, {
  text: '看起来不对但我确认没问题',
  markDone: true,
})
check('用户判断优先于机器判定', r.body?.status === 'ok', JSON.stringify(r.body))

// 6. 空提交被拒
r = await call('POST', `/steps/${markOnly.id}/evidence`, {})
check('空提交被拒', r.status === 400, `status ${r.status}`)

// 7. 证据真的落库了，刷新后还在
const detail = (await call('GET', `/tasks/${task.id}/runbook`)).body
const ev = detail.evidence[matched.id] ?? []
check('证据已落库', ev.length === 1 && ev[0].source === 'paste', JSON.stringify(ev))
check(
  '步骤状态已持久化',
  detail.steps.find((s) => s.id === matched.id)?.status === 'ok',
  detail.steps.find((s) => s.id === matched.id)?.status,
)

// 8. 脱敏：贴进来的凭据不该原样存
r = await call('POST', `/steps/${noExpect.id}/evidence`, {
  text: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx',
})
const after = (await call('GET', `/tasks/${task.id}/runbook`)).body
const pasted = (after.evidence[noExpect.id] ?? []).map((e) => e.text).join('\n')
check(
  '贴进来的凭据已脱敏',
  !pasted.includes('sk-abcdefghijklmnopqrstuvwx'),
  pasted.slice(0, 120),
)

console.log('─── 手动证据路径 ───')
let failed = 0
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
process.exit(failed === 0 ? 0 : 1)
