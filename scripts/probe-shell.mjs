/**
 * 探测 dsh 的 shell 实际行为：哪些命令能用、输出长什么样。
 *
 * 环境采集的命令必须适配真实 shell，猜不得。
 */
const API = `http://127.0.0.1:${process.env.QB_PORT ?? 3080}/qb/api`

const PROBES = [
  ['uname', 'uname -sr'],
  ['ver', 'ver'],
  ['cmd /c ver', 'cmd /c ver'],
  ['$PSVersionTable', '$PSVersionTable.PSVersion.ToString()'],
  ['OS env', 'echo $env:OS'],
  ['shell env', 'echo $SHELL'],
  ['systeminfo', '[System.Environment]::OSVersion.VersionString'],
  ['pwd', 'pwd'],
  ['which bash', 'where.exe bash'],
]

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const task = (await post('/tasks', { title: 'shell probe' })).body

const rb = (
  await post(`/tasks/${task.id}/runbook`, {
    steps: PROBES.map(([name, command]) => ({ kind: 'command', title: name, command, timeoutMs: 15000 })),
  })
).body

for (const step of rb.steps) {
  await post(`/steps/${step.id}/run`, {})
  await new Promise((r) => setTimeout(r, 1200))
}

await new Promise((r) => setTimeout(r, 2000))

const detail = await (await fetch(`${API}/tasks/${task.id}/runbook`)).json()
for (const s of detail.steps) {
  const ev = (detail.evidence[s.id] ?? [])[0]
  const out = (ev?.text ?? '').trim().split('\n').slice(0, 2).join(' | ')
  console.log(`${s.status === 'ok' ? '✓' : '✗'} ${s.title.padEnd(16)} ${out.slice(0, 90)}`)
}
