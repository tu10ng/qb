/**
 * 冒烟验证：真起一个 dsh，确认 QB 插件挂得上、数据能存、命令能跑。
 *
 * 这不是单元测试（它要几十秒、要真进程），所以不在 vitest 里跑。
 * 用法：pnpm smoke
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const scratch = join(repoRoot, '.smoke')
const dshHome = join(scratch, 'dsh-home')
const distDir = join(scratch, 'dist')
const dbPath = join(scratch, 'qb.db')

const PORT = 3099
const MOUNT = '/qb'
const BASE = `http://127.0.0.1:${PORT}${MOUNT}`
const API = `${BASE}/api`

let child

async function main() {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<html><body>QB SMOKE</body></html>')

  const patch = join(scratch, 'patch.yml')
  await writeFile(
    patch,
    [
      '- insert:',
      '    - id: qb-engine',
      `      name: '${pathToFileUrl(join(repoRoot, 'packages/engine/src/index.ts'))}'`,
      '      inject: [webServer, shell, timer]',
      '      config:',
      `        distDir: '${posix(distDir)}'`,
      `        dbPath: '${posix(dbPath)}'`,
      `        mountPath: '${MOUNT}'`,
      "        userName: 'smoke'",
      '',
    ].join('\n'),
  )

  console.log('启动 dsh...')
  child = spawn(
    process.execPath,
    [
      join(repoRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      'web',
      '--patch',
      patch,
      '--no-open',
      '--port',
      String(PORT),
    ],
    { env: { ...process.env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let log = ''
  child.stdout.on('data', (d) => {
    log += d
    process.stdout.write(`  dsh| ${d}`)
  })
  child.stderr.on('data', (d) => {
    log += d
    process.stderr.write(`  dsh! ${d}`)
  })

  const ready = await waitFor(() => fetch(`${API}/health`).then((r) => r.ok), 90_000)
  if (!ready) {
    console.error('\n✗ dsh 没能在 90 秒内就绪。日志：\n' + log.slice(-3000))
    process.exit(1)
  }

  const checks = []
  const check = (label, ok, detail = '') => checks.push([label, ok, detail])

  // ── 挂载与共存 ──────────────────────────────────────────
  const health = await (await fetch(`${API}/health`)).json()
  check('插件已加载', health.service === 'qb-engine', JSON.stringify(health))

  const spa = await (await fetch(`${BASE}/`)).text()
  check('SPA 可访问', spa.includes('QB SMOKE'))

  // 401 是预期的（dsh 内置 UI 要 token）；只要不是 404 就说明
  // 它的 fallback 还在，我们的 prefix 路由没盖住它。
  // 内置 UI 的静态服务可能晚于我们就绪，所以给它一点时间。
  const builtinOk = await waitFor(
    () => fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status !== 404),
    30_000,
  )
  const builtin = await fetch(`http://127.0.0.1:${PORT}/`)
  check('dsh 内置 UI 共存', builtinOk, `status ${builtin.status}`)

  // ── 数据层（better-sqlite3 能否在 dsh 里加载） ──────────
  const me = await (await fetch(`${API}/me`)).json()
  check('SQLite 可用且有当前用户', me.name === 'smoke', JSON.stringify(me))

  const created = await fetch(`${API}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '在测试集群跑通 PD 分离', briefMd: '冒烟用' }),
  })
  const task = await created.json()
  check('能建任务', created.status === 201 && task.status === 'draft', JSON.stringify(task))

  const listed = await (await fetch(`${API}/tasks`)).json()
  check('任务列表可读', listed.tasks?.length === 1, JSON.stringify(listed))

  // ── WS + 执行链路 ──────────────────────────────────────
  const wsEvents = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${MOUNT}/ws`)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
    setTimeout(() => rej(new Error('WS 连接超时')), 10_000)
  })
  ws.addEventListener('message', (e) => {
    try {
      wsEvents.push(JSON.parse(e.data))
    } catch {
      /* 忽略非 JSON */
    }
  })
  check('WS 可连接', ws.readyState === WebSocket.OPEN)

  // 步骤必须来自真源，不能凭前端传命令
  const ghost = await fetch(`${API}/steps/nonexistent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('不存在的步骤被拒', ghost.status === 404, `status ${ghost.status}`)

  // ── 完整链路：起 runbook → 跑步骤 → 状态落库 ────────────
  const rbRes = await fetch(`${API}/tasks/${task.id}/runbook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assumptions: [{ key: '集群', value: '测试集群', editedByUser: false }],
      steps: [
        {
          kind: 'command',
          title: '验证 shell 可用',
          whyMd: '确认执行链路通了',
          command: 'echo QB_SHELL_WORKS',
          expectation: { kind: 'contains', text: 'QB_SHELL_WORKS', caseSensitive: true },
          timeoutMs: 15000,
        },
        {
          kind: 'command',
          title: '验证超时生效',
          command: 'sleep 30',
          timeoutMs: 2000,
        },
        {
          kind: 'command',
          title: '破坏性命令',
          command: 'rm -rf /tmp/qb-smoke-nonexistent',
          timeoutMs: 5000,
        },
      ],
    }),
  })
  const rb = await rbRes.json()
  check('能写入 runbook', rbRes.status === 201 && rb.steps?.length === 3, JSON.stringify(rb).slice(0, 200))

  const [okStep, timeoutStep, dangerStep] = rb.steps ?? []

  // 1) 正常执行 + 预期判定 + 流式输出
  const run1 = await fetch(`${API}/steps/${okStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('步骤已受理', run1.status === 202, `status ${run1.status}`)

  await waitFor(() => wsEvents.some((e) => e.type === 'step.done' && e.stepId === okStep.id), 30_000)
  const done1 = wsEvents.find((e) => e.type === 'step.done' && e.stepId === okStep.id)
  check('预期判定为 pass', done1?.verdict === 'pass', JSON.stringify(done1 ?? null))
  check(
    '输出已流式推送',
    wsEvents.some((e) => e.type === 'step.output' && String(e.text).includes('QB_SHELL_WORKS')),
  )

  // 2) 状态真的落库了
  const afterRun = await (await fetch(`${API}/tasks/${task.id}/runbook`)).json()
  const okStepAfter = afterRun.steps.find((s) => s.id === okStep.id)
  check('步骤状态已落库', okStepAfter?.status === 'ok', JSON.stringify(okStepAfter ?? null))
  check('耗时已记录', typeof okStepAfter?.actualMs === 'number')
  check(
    '任务自动转为进行中',
    afterRun.task.status === 'active',
    `status=${afterRun.task.status}`,
  )
  check(
    '事件时间线已记录',
    afterRun.events.some((e) => e.kind === 'step_run') &&
      afterRun.events.some((e) => e.kind === 'step_ok'),
    JSON.stringify(afterRun.events.map((e) => e.kind)),
  )

  // 3) 超时
  const t0 = Date.now()
  await fetch(`${API}/steps/${timeoutStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  await waitFor(
    () => wsEvents.some((e) => e.type === 'step.done' && e.stepId === timeoutStep.id),
    25_000,
  )
  const elapsed = Date.now() - t0
  const doneTimeout = wsEvents.find((e) => e.type === 'step.done' && e.stepId === timeoutStep.id)
  check(
    '超时在限期内被终止',
    doneTimeout !== undefined && elapsed < 20_000,
    `elapsed=${elapsed}ms event=${JSON.stringify(doneTimeout ?? null)}`,
  )

  // 4) 破坏性命令：先拒，确认后放行
  const denied = await fetch(`${API}/steps/${dangerStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const deniedBody = await denied.json()
  check(
    '破坏性命令需确认',
    denied.status === 409 && deniedBody.error === 'needs_confirmation',
    JSON.stringify(deniedBody),
  )

  const allowed = await fetch(`${API}/steps/${dangerStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  })
  check('确认后放行', allowed.status === 202, `status ${allowed.status}`)

  // 5) 重规划产生新版本
  const replan = await fetch(`${API}/tasks/${task.id}/runbook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason: '情况变了：审批人请假',
      steps: [{ kind: 'command', title: '改过的步骤', command: 'echo replanned' }],
    }),
  })
  const replanBody = await replan.json()
  check('重规划产生新版本', replanBody.runbook?.version === 2, JSON.stringify(replanBody.runbook ?? null))

  const versions = await (await fetch(`${API}/tasks/${task.id}/versions`)).json()
  check('旧版本保留', versions.versions?.length === 2, JSON.stringify(versions))

  console.log('\n─── 结果 ───')
  let failed = 0
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
    if (!ok) failed++
  }

  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

function posix(p) {
  return p.replaceAll('\\', '/')
}

function pathToFileUrl(p) {
  const n = posix(p)
  return n.startsWith('/') ? `file://${n}` : `file:///${n}`
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

process.on('exit', () => child?.kill())
process.on('SIGINT', () => {
  child?.kill()
  process.exit(130)
})

main().catch((e) => {
  console.error(e)
  child?.kill()
  process.exit(1)
})
