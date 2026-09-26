/**
 * 冒烟验证：真起一个 dsh，确认 QB 插件挂得上、路由可达、命令能跑。
 *
 * 这不是单元测试（它要几十秒、要网络、要真进程），所以不在 vitest 里跑。
 * 用法：node scripts/smoke.mjs
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

const PORT = 3099
const MOUNT = '/qb'
const BASE = `http://127.0.0.1:${PORT}${MOUNT}`

let child

async function main() {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })

  // 一个最小的 SPA 产物，验证静态托管
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
      `        distDir: '${distDir.replaceAll('\\', '/')}'`,
      `        mountPath: '${MOUNT}'`,
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
    {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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

  const ready = await waitFor(() => fetch(`${BASE}/api/health`).then((r) => r.ok), 90_000)
  if (!ready) {
    console.error('\n✗ dsh 没能在 90 秒内就绪。日志：\n' + log.slice(-3000))
    process.exit(1)
  }

  const checks = []

  // 1. 健康检查 = 插件确实被加载（dsh 会静默跳过不兼容的 bundle）
  const health = await (await fetch(`${BASE}/api/health`)).json()
  checks.push(['插件已加载', health.service === 'qb-engine', JSON.stringify(health)])

  // 2. SPA 托管
  const spa = await (await fetch(`${BASE}/`)).text()
  checks.push(['SPA 可访问', spa.includes('QB SMOKE'), spa.slice(0, 60)])

  // 3. dsh 内置 UI 仍在（共存，没抢 fallback）。
  //    401 是预期的：dsh 内置 UI 要求 URL 带 token。只要不是 404，
  //    就说明它的 fallback 路由还在，我们的 prefix 路由没有覆盖它。
  const builtin = await fetch(`http://127.0.0.1:${PORT}/`)
  checks.push(['dsh 内置 UI 共存', builtin.status !== 404, `status ${builtin.status}`])

  // 4. 真跑一条命令，并通过 WS 收结果——202 只代表受理，
  //    必须确认输出真的流回来了、预期判定真的生效了。
  const wsEvents = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${MOUNT}/ws`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
    setTimeout(() => reject(new Error('WS 连接超时')), 10_000)
  })
  ws.addEventListener('message', (e) => {
    try {
      wsEvents.push(JSON.parse(e.data))
    } catch {
      // 忽略非 JSON
    }
  })
  checks.push(['WS 可连接', ws.readyState === WebSocket.OPEN, `readyState ${ws.readyState}`])

  const runRes = await fetch(`${BASE}/api/steps/smoke1/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command: 'echo QB_SHELL_WORKS',
      expectation: { kind: 'contains', text: 'QB_SHELL_WORKS', caseSensitive: true },
      timeoutMs: 15_000,
    }),
  })
  const runBody = await runRes.text()
  checks.push(['命令已受理', runRes.status === 202, `status ${runRes.status} ${runBody}`])

  // 等 step.done
  const done = await waitFor(() => wsEvents.some((e) => e.type === 'step.done'), 30_000)
  const doneEvent = wsEvents.find((e) => e.type === 'step.done')
  checks.push(['收到执行完成事件', done, JSON.stringify(wsEvents)])
  checks.push([
    '预期判定为 pass',
    doneEvent?.verdict === 'pass',
    JSON.stringify(doneEvent ?? null),
  ])
  checks.push([
    '命令输出已流式推送',
    wsEvents.some((e) => e.type === 'step.output' && String(e.text).includes('QB_SHELL_WORKS')),
    JSON.stringify(wsEvents.filter((e) => e.type === 'step.output')),
  ])

  // 6. 超时真的生效
  const timeoutStart = Date.now()
  await fetch(`${BASE}/api/steps/smoke3/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'sleep 30', timeoutMs: 2000 }),
  })
  await waitFor(() => wsEvents.some((e) => e.type === 'step.done' && e.stepId === 'smoke3'), 25_000)
  const timeoutEvent = wsEvents.find((e) => e.type === 'step.done' && e.stepId === 'smoke3')
  const elapsed = Date.now() - timeoutStart
  checks.push([
    '超时在限期内被终止',
    timeoutEvent !== undefined && elapsed < 20_000,
    `elapsed=${elapsed}ms event=${JSON.stringify(timeoutEvent ?? null)}`,
  ])

  ws.close()

  // 5. 破坏性命令需要确认
  const danger = await fetch(`${BASE}/api/steps/smoke2/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'rm -rf /tmp/whatever', timeoutMs: 5000 }),
  })
  const dangerBody = await danger.json()
  checks.push([
    '破坏性命令拦截',
    danger.status === 409 && dangerBody.error === 'needs_confirmation',
    JSON.stringify(dangerBody),
  ])

  console.log('\n─── 结果 ───')
  let failed = 0
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
    if (!ok) failed++
  }

  process.exit(failed === 0 ? 0 : 1)
}

function pathToFileUrl(p) {
  const normalized = p.replaceAll('\\', '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true
    } catch {
      // 还没起来
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
