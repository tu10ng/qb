/**
 * 界面真浏览器检查（Edge/Chrome，puppeteer-core）：Phase 0 的界面改动。
 *
 * - 三个宽度（1920 / 1200 / 800）下正文不被挤扁，常用动作在顶栏点得到
 * - 专注模式、"只看主线"已删
 * - 没有参数的 runbook 也有参数面板；未声明的参数一键声明
 * - wait 步骤有"只盯着"；委派行有"打开对方 runbook"
 * - 卡住了 → 横幅；完成任务 → 复盘弹层
 * - 远程（发起人）界面能选中某一步评论
 *
 * 用法：node scripts/e2e/ui-check.mjs
 * 浏览器路径可用 QB_E2E_BROWSER 覆盖；截图存到 QB_E2E_SHOTS（默认系统临时目录）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { createRun, freePort, json, sleep } from './lib.mjs'

const BROWSERS = [
  process.env.QB_E2E_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => p !== undefined && existsSync(p))
const shots = process.env.QB_E2E_SHOTS ?? join(tmpdir(), 'qb-ui-shots')
mkdirSync(shots, { recursive: true })

const run = createRun('ui-check')
const { check } = run
let browser = null

try {
  if (BROWSERS.length === 0) throw new Error('找不到 Edge/Chrome，用 QB_E2E_BROWSER 指定浏览器路径')

  // ── 准备：团队 + 一台引擎 + 发起人令牌 ─────────────────────────
  const team = await run.startTeam(await freePort())
  const pl = (await json(team.url, '/api/join', 'POST', { invite: team.invite, name: 'laowang' })).body
  const ua = (await json(team.url, '/api/join', 'POST', { invite: team.invite, name: 'xiaoa' })).body
  await json(team.url, '/api/join', 'POST', { invite: team.invite, name: 'xiaob' })
  const enginePort = await freePort()
  const A = await run.startEngine('a', enginePort, 'xiaoa')
  await json(A, '/settings/team', 'POST', { url: team.url, token: ua.token, enabled: true })

  const task = (await json(A, '/tasks', 'POST', { title: '界面检查：Y 集群 PD 分离部署', initiatorName: 'laowang' })).body
  const rb = (await json(A, `/tasks/${task.id}/runbook`, 'POST', {
    steps: [
      {
        kind: 'note',
        title: '1 启动',
        children: [
          { kind: 'command', title: '登录 decode 节点', command: 'ssh {{DECODE_HOST}} hostname', whyMd: 'decode 侧先起，prefill 才能注册 KV 通道' },
          { kind: 'wait', title: '等 decode 就绪', command: 'echo started', probe: { kind: 'http', url: 'http://127.0.0.1:9/health', expectStatus: 200 }, timeoutMs: 60_000 },
          { kind: 'manual', title: '找老王要 gpu-18 权限' },
        ],
      },
    ],
  })).body
  const manual = rb.steps.find((s) => s.title === '找老王要 gpu-18 权限')
  const dg = await json(A, `/steps/${manual.id}/delegate`, 'POST', { assigneeName: 'xiaob', displayName: '小B' })
  check('准备数据：委派出去一步', dg.status === 201, dg.body)
  await sleep(2500) // 让镜像先到团队

  browser = await puppeteer.launch({ executablePath: BROWSERS[0], headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`)
  })

  const openTask = async () => {
    await page.goto(`http://127.0.0.1:${enginePort}/qb/`, { waitUntil: 'networkidle2', timeout: 30_000 })
    const w = await page.evaluate(() => innerWidth)
    // 窄屏任务列表是抽屉：先打开
    if (w < 1000) await page.click('.nav-toggle')
    await page.evaluate((title) => {
      const el = [...document.querySelectorAll('.task-item')].find((e) => (e.textContent ?? '').includes(title))
      el?.click()
    }, task.title)
    await page.waitForSelector('.task-header h1', { timeout: 10_000 })
    await sleep(600)
  }
  const text = () => page.evaluate(() => document.body.innerText)
  const visible = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s)
      if (el === null) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
    }, sel)

  // ── 1. 三个宽度 ────────────────────────────────────────────
  for (const [w, h] of [[1920, 1000], [1200, 800], [800, 700]]) {
    await page.setViewport({ width: w, height: h })
    await openTask()
    const runbookWidth = await page.evaluate(() => document.querySelector('.runbook')?.getBoundingClientRect().width ?? 0)
    check(`${w}px：正文宽 ${Math.round(runbookWidth)}px，没被挤扁（原先 800px 下挤成一字一行）`, runbookWidth >= Math.min(560, w * 0.6), runbookWidth)
    const actions = await page.evaluate(() => [...document.querySelectorAll('.header-actions button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent?.trim()))
    check(`${w}px：常用动作在顶栏点得到`, ['问发起人', '情况变了…', '贴终端记录', '卡住了', '完成任务'].every((a) => actions.some((x) => (x ?? '').startsWith(a))), actions)
    if (w === 1920) check('1920px：大纲和 QB 面板都在', (await visible('.outline')) && (await visible('.qb-panel')))
    if (w === 1200) check('1200px：QB 面板收成抽屉，大纲还在', !(await visible('.qb-panel')) && (await visible('.outline')))
    if (w === 800) check('800px：任务列表和大纲收成抽屉', !(await visible('.sidebar')) && !(await visible('.outline')))
    await page.screenshot({ path: join(shots, `phase0-${w}.png`) })
  }

  await page.setViewport({ width: 1440, height: 900 })
  await openTask()
  const body = await text()
  check('专注模式和"只看主线"都删了', !body.includes('专注模式') && !body.includes('只看主线'))

  // ── 2. 参数：没有参数也有面板；未声明的一键声明 ────────────────
  check('没有参数的 runbook 也有参数面板（原先不渲染 → 死路）', body.includes('参数 · 还没有'))
  const declared = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '声明为参数')
    b?.click()
    return b !== undefined
  })
  check('未声明的参数有"声明为参数"按钮', declared)
  await sleep(1200)
  check('声明后参数面板里出现 DECODE_HOST', (await text()).includes('DECODE_HOST'))

  // ── 3. wait 步骤、委派行 ────────────────────────────────────
  check('wait 步骤有"👀 只盯着"', (await text()).includes('只盯着'))
  check('委派行有"打开对方 runbook"和对方进度', (await text()).includes('打开对方 runbook') && (await text()).includes('xiaob · 还没开始'))

  // ── 4. 卡住了 → 横幅；继续；完成任务 → 复盘 ─────────────────────
  await page.evaluate(() => [...document.querySelectorAll('.header-actions button')].find((b) => b.textContent?.trim() === '卡住了')?.click())
  await page.waitForSelector('.modal textarea', { timeout: 5000 })
  await page.type('.modal textarea', '等 gpu-18 的权限')
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent?.includes('告诉发起人'))?.click())
  await sleep(1500)
  check('卡住了 → 顶部红色横幅带原因', (await text()).includes('卡住了：等 gpu-18 的权限'))
  await page.screenshot({ path: join(shots, 'phase0-blocked.png') })

  await page.evaluate(() => [...document.querySelectorAll('.header-actions button')].find((b) => b.textContent?.trim() === '完成任务')?.click())
  await sleep(1500)
  check('完成任务 → 自动打开复盘', (await text()).includes('复盘 · 沉淀候选'))
  await page.screenshot({ path: join(shots, 'phase0-retro.png') })

  // ── 5. 远程界面：选中一步评论 ──────────────────────────────────
  const remote = await browser.newPage()
  remote.on('pageerror', (e) => errors.push(`remote pageerror: ${e.message}`))
  await remote.setViewport({ width: 1440, height: 900 })
  await remote.goto(`${team.url}/`, { waitUntil: 'networkidle2' })
  await remote.evaluate((t) => localStorage.setItem('qb-team-token', t), pl.token)
  await remote.goto(`${team.url}/`, { waitUntil: 'networkidle2' })
  await remote.evaluate((title) => [...document.querySelectorAll('.task-item')].find((e) => (e.textContent ?? '').includes(title))?.click(), task.title)
  await sleep(1200)
  await remote.evaluate(() => [...document.querySelectorAll('.step .step-title')].find((e) => e.textContent?.includes('登录 decode 节点'))?.click())
  await sleep(400)
  check('远程：选中一步后出现"评论这一步"（原先只能评论整个任务）', (await remote.evaluate(() => document.body.innerText)).includes('评论这一步'))
  await remote.screenshot({ path: join(shots, 'phase0-remote.png') })

  check('全程没有页面报错', errors.length === 0, errors.slice(0, 5))
  console.log(`截图：${shots}`)
} catch (e) {
  console.log(run.tail(30))
  console.log(e)
  check('脚本没有异常退出', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser?.close()
  const failed = await run.finish()
  process.exit(failed === 0 ? 0 : 1)
}
