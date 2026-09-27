/**
 * e2e 公共件：真起团队服务与 dsh 引擎（独立端口、独立库、独立 dsh-home），
 * 不碰 3080 上的开发实例。
 *
 * 引擎按 scripts/dev.mjs 的方式挂载 QB 插件（--patch），UI 用
 * QB_E2E_UI_DIR 指定的构建产物（默认 packages/ui/dist）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const uiDir = process.env.QB_E2E_UI_DIR ?? join(repoRoot, 'packages/ui/dist')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到 fn() 为真或超时；返回是否等到了。 */
export async function wait(fn, ms, every = 300) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(every)
  }
  return false
}

/** JSON 请求，返回 { status, body }。 */
export function json(base, path, method = 'GET', body, token) {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

/** 拿一个空闲端口。 */
export function freePort() {
  return new Promise((resolveP, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolveP(port))
    })
  })
}

/**
 * 一次 e2e 运行：收集检查结果、子进程与日志，结束时统一清理。
 */
export function createRun(name) {
  const dir = mkdtempSync(join(tmpdir(), `qb-e2e-${name}-`))
  const procs = []
  let log = ''
  const results = []

  const check = (label, ok, detail = '') => {
    results.push([label, Boolean(ok), detail])
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
    return Boolean(ok)
  }

  const track = (child, tag) => {
    child.stdout.on('data', (d) => (log += `[${tag}] ${d}`))
    child.stderr.on('data', (d) => (log += `[${tag}!] ${d}`))
    procs.push(child)
    return child
  }

  /** 团队服务：返回 { url, invite, restart }。 */
  async function startTeam(port) {
    const db = join(dir, 'team.db')
    const spawnTeam = () =>
      track(
        spawn(process.execPath, ['--experimental-strip-types', 'packages/team/src/index.ts', '--db', db, '--port', String(port), '--host', '127.0.0.1', '--ui', uiDir], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        'team',
      )
    let child = spawnTeam()
    const url = `http://127.0.0.1:${port}`
    const up = await wait(() => fetch(`${url}/api/health`).then((r) => r.ok), 20_000)
    if (!up) throw new Error(`团队服务没起来：${log.slice(-600)}`)
    await wait(() => /#\/join\/([A-Za-z0-9]+)/.test(log), 5000)
    const invite = /#\/join\/([A-Za-z0-9]+)/.exec(log)?.[1] ?? ''
    const handle = {
      url,
      invite,
      /** 停掉并等进程真的退出、端口真的不通（Windows 上端口释放有延迟）。 */
      async stop() {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill()
        await exited
        await wait(() => fetch(`${url}/api/health`).then(() => false, () => true), 10_000)
      },
      async start() {
        child = spawnTeam()
        const ok = await wait(() => fetch(`${url}/api/health`).then((r) => r.ok), 20_000)
        if (!ok) throw new Error(`团队服务没能重新起来：${log.slice(-600)}`)
      },
      async restart() {
        await handle.stop()
        await handle.start()
      },
    }
    return handle
  }

  /**
   * 一台引擎。user 为 undefined 时不传 userName（默认 me——验证团队身份绑定）。
   * env 覆盖告警阈值等。返回 API 基地址。
   */
  async function startEngine(tag, port, user, env = {}) {
    const runDir = join(dir, tag)
    mkdirSync(runDir, { recursive: true })
    const patch = join(runDir, 'patch.yml')
    const posix = (p) => p.replaceAll('\\', '/')
    writeFileSync(
      patch,
      [
        '- insert:',
        '    - id: qb-engine',
        `      name: 'file:///${posix(join(repoRoot, 'packages/engine/src/index.ts'))}'`,
        '      inject: [webServer, shell, timer]',
        '      config:',
        `        distDir: '${posix(uiDir)}'`,
        `        dbPath: '${posix(join(runDir, 'qb.db'))}'`,
        "        mountPath: '/qb'",
        ...(user !== undefined ? [`        userName: '${user}'`] : []),
        '',
      ].join('\n'),
      'utf8',
    )
    // 不继承本机 .env.local 里的模型与用户配置：e2e 要可复现
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QB_')))
    track(
      spawn(process.execPath, [join(repoRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patch, '--no-open', '--port', String(port)], {
        cwd: repoRoot,
        env: { ...baseEnv, DSH_HOME: join(runDir, 'dsh-home'), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      tag,
    )
    const base = `http://127.0.0.1:${port}/qb/api`
    const up = await wait(() => fetch(`${base}/health`).then((r) => r.ok), 40_000)
    if (!up) throw new Error(`引擎 ${tag} 没起来：${log.slice(-800)}`)
    return base
  }

  async function finish() {
    for (const p of procs) p.kill()
    await sleep(600)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* Windows 句柄释放慢：临时目录留给系统 */
    }
    const failed = results.filter(([, ok]) => !ok).length
    console.log(`\n${name}：${results.length - failed}/${results.length} 通过`)
    return failed
  }

  return { dir, check, startTeam, startEngine, finish, tail: (n = 40) => log.split('\n').slice(-n).join('\n') }
}
