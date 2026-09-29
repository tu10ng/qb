/**
 * 手册端到端：用户手测报的 13 个问题（2026-09-29），每一条真跑一遍。
 *
 * 真起一台引擎（不配模型——那正是报的场景）+ 团队服务 + 真浏览器：
 *   1  建任务只要一句话；说明、发起人建完再补；能从别的任务挑章节拼
 *   2  没模型也能从空白开始写
 *   3  手册不只是执行清单：参考章节只有文字和链接
 *   4  参数名能用中文；"IP 用户 密码" 一行是一个机器参数（密码打码）
 *   5  命令框随内容长高、没有抓手、能折叠、能标语言
 *   6  回显是一等公民：参考回显 + 历次/别的任务里的回显对比
 *   7  参数能归到某一章下面
 *   8  长命令只运行选中的几行
 *   9  粘贴多行命令：内容照常贴进去，按 shell 语法问要不要拆
 *   10 右侧不再是流水账：这一步 / 问答 / 记录
 *   11 树形：章节任意层级，步骤能挂子步骤
 *   12 坑改成问答：只写问或只写答都行，能挂在整份文档上，问发起人的回答填回来
 *   13 直接导入 markdown / org（连同图片），也能导出 markdown
 *
 * 用法：node scripts/e2e/manual.mjs（或 pnpm e2e manual）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import puppeteer from 'puppeteer-core'
import { createRun, freePort, json, repoRoot, sleep, wait } from './lib.mjs'

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

const run = createRun('manual')
const { check } = run
let browser = null

/** 一张 2x2 的 png（颜色不同，哈希就不同）。 */
function png(r, g, b) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.from([0, r, g, b, r, g, b])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))])
}

try {
  if (BROWSERS.length === 0) throw new Error('找不到 Edge/Chrome，用 QB_E2E_BROWSER 指定浏览器路径')

  const team = await run.startTeam(await freePort())
  const pl = (await json(team.url, '/api/join', 'POST', { invite: team.invite, name: 'laowang' })).body
  const ua = (await json(team.url, '/api/join', 'POST', { invite: team.invite, name: 'xiaoa' })).body
  const port = await freePort()
  const A = await run.startEngine('a', port, 'xiaoa')
  const base = `http://127.0.0.1:${port}/qb`
  const settings = (await json(A, '/settings/llm', 'GET')).body
  check('引擎没配模型（用户报问题时的场景）', settings?.status?.structure?.ok === false, settings?.status)

  // 用户的部署笔记（IP 已换成虚构的）+ 里面引用的截图
  const noteDir = join(run.dir, 'note')
  mkdirSync(noteDir, { recursive: true })
  const notePath = join(noteDir, '部署笔记.md')
  writeFileSync(notePath, readFileSync(join(repoRoot, 'packages/core/test/fixtures/deploy-note.md')))
  const images = ['e4431e9d-8faa-415f-a11b-83ab59775bd2.png', '63cbfc74-14bf-42ff-a05e-dba970ba49fa.png', 'e647b615-c343-40e1-9723-8b115f5ee925.png']
  images.forEach((n, i) => writeFileSync(join(noteDir, n), png(60 * i, 140, 220 - 60 * i)))

  browser = await puppeteer.launch({ executablePath: BROWSERS[0], headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`)
  })
  const text = () => page.evaluate(() => document.body.innerText)
  const clickText = (sel, t) =>
    page.evaluate(
      (s, tt) => {
        const el = [...document.querySelectorAll(s)].find((e) => (e.textContent ?? '').trim().startsWith(tt))
        el?.click()
        return el !== undefined
      },
      sel,
      t,
    )
  const openTask = async (title) => {
    await page.goto(`${base}/`, { waitUntil: 'networkidle2' })
    await page.evaluate((t) => [...document.querySelectorAll('.task-item')].find((e) => (e.textContent ?? '').includes(t))?.click(), title)
    await page.waitForSelector('.task-header h1', { timeout: 10_000 })
    await sleep(700)
  }
  const detailOf = async (id) => (await json(A, `/tasks/${id}/runbook`, 'GET')).body

  // ── 1 / 2：一句话建任务，没模型也能写 ───────────────────────────
  await page.goto(`${base}/`, { waitUntil: 'networkidle2' })
  check('1 建任务只有一个输入框（说明、发起人建完再补）', (await page.evaluate(() => document.querySelectorAll('.new-task-form input, .new-task-form textarea').length)) === 1)
  await page.type('.new-task-form input', '用2和3号卡部署qwen3.6 27b')
  await clickText('.new-task-form button', '创建')
  await page.waitForSelector('.start-panel', { timeout: 10_000 })
  const start = await text()
  check('2 没模型时能自己写、导入 md/org、从已有任务挑（原先只剩"去设置"）', start.includes('自己写') && start.includes('导入 markdown / org') && start.includes('从已有的任务挑') && !start.includes('还没有配置模型。'))
  await page.screenshot({ path: join(shots, 'manual-start.png') })
  await clickText('.start-card button', '写第一条命令')
  await page.waitForSelector('.code-edit textarea', { timeout: 5000 })
  await page.keyboard.type('docker images')
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')
  await sleep(900)
  const task = ((await json(A, '/tasks', 'GET')).body.tasks ?? []).find((t) => t.title.startsWith('用2和3号卡'))
  let d = await detailOf(task.id)
  check('2 手写的第一条命令存下了，标题按命令自动取', d.steps.length === 1 && d.steps[0].command === 'docker images' && d.steps[0].titleAuto === true, d.steps)

  await clickText('.task-info button', '＋ 补充说明')
  await page.type('.task-info textarea', '最小运行，速度 10tps 就行')
  await clickText('.task-info button', '保存')
  await sleep(600)
  await clickText('.task-info button', '＋ 谁派的活')
  await page.type('.task-info input', 'laowang')
  await clickText('.task-info button', '好')
  await sleep(700)
  d = await detailOf(task.id)
  check('1 建完再补说明和发起人', d.task.briefMd === '最小运行，速度 10tps 就行' && d.initiator?.name === 'laowang', { brief: d.task.briefMd, initiator: d.initiator })

  // ── 13：导入 markdown（连同截图） ─────────────────────────────
  const t2 = (await json(A, '/tasks', 'POST', { title: '导入：部署笔记' })).body
  await openTask('导入：部署笔记')
  const input = await page.$('.start-card input[type=file]')
  await input.uploadFile(notePath, ...images.map((n) => join(noteDir, n)))
  const imported = await wait(async () => ((await detailOf(t2.id))?.steps ?? []).length > 10, 15_000)
  d = await detailOf(t2.id)
  const kinds = d.steps.reduce((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {})
  check('13 导入 md：章节、命令、文字、代码、回显都认出来', imported && kinds.section >= 10 && kinds.command >= 5 && kinds.note >= 3 && kinds.code >= 1 && kinds.output >= 3, kinds)
  const dockerRun = d.steps.find((s) => (s.command ?? '').startsWith('docker run'))
  check('13 docker run（带续行）逐字保留、不被拆', dockerRun?.command.split('\n').length === 8)
  const imagesStep = d.steps.find((s) => s.command === 'docker images')
  check('13 截图跟着命令成了参考回显，图片带上了', (imagesStep?.refMd ?? '').includes('/qb/api/attachments/'), imagesStep?.refMd)
  const img = await page.evaluate(() => {
    const i = document.querySelector('.reference img')
    return i === null ? null : { ok: i.complete && i.naturalWidth > 0 }
  })
  check('13 参考回显里的截图在页面上显示', img?.ok === true, img)
  const depth = (s) => {
    let n = 0
    let p = s.parentId
    while (p !== null) {
      n++
      p = d.steps.find((x) => x.id === p)?.parentId ?? null
    }
    return n
  }
  check('11 导入后是多层章节（3 层以上）', Math.max(...d.steps.map(depth)) >= 3)
  await page.screenshot({ path: join(shots, 'manual-imported.png') })

  // org 也行（直接粘贴）
  const t3 = (await json(A, '/tasks', 'POST', { title: '导入：org 笔记' })).body
  const org = await json(A, `/tasks/${t3.id}/import-doc`, 'POST', { text: readFileSync(join(repoRoot, 'packages/core/test/fixtures/notes.org'), 'utf8'), filename: 'notes.org' })
  check('13 org-mode 也能导入（标题层级、src 块、example 块）', org.status === 201 && org.body.stats.sections >= 8 && org.body.stats.commands >= 1 && org.body.stats.code >= 1, org.body)

  // ── 3：参考章节——只有文字和链接，没有执行按钮 ────────────────────
  const refSec = (await json(A, `/runbooks/${d.runbook.id}/steps`, 'POST', { parentId: null, afterId: null, step: { kind: 'section', title: '参考' } })).body.step
  await json(A, `/runbooks/${d.runbook.id}/steps`, 'POST', { parentId: refSec.id, afterId: null, step: { kind: 'note', title: '链接', titleAuto: true, bodyMd: '- [vllm-ascend 文档](https://docs.vllm.ai/projects/ascend)\n- 昇腾 wiki：https://example.com/wiki' } })
  await openTask('导入：部署笔记')
  const refBlock = await page.evaluate(() => {
    const note = [...document.querySelectorAll('.block.note')].find((b) => (b.textContent ?? '').includes('vllm-ascend 文档'))
    if (note === undefined) return null
    const buttons = [...note.querySelectorAll('button')].map((x) => x.textContent?.trim() ?? '')
    return { links: note.querySelectorAll('a[target=_blank]').length, hasDone: buttons.includes('完成'), hasRun: buttons.some((b) => b.includes('运行')) }
  })
  check('3 参考章节：链接可点、新窗口打开，没有完成/运行按钮', refBlock !== null && refBlock.links === 2 && !refBlock.hasDone && !refBlock.hasRun, refBlock)
  const meta = await page.evaluate(() => document.querySelector('.task-meta')?.textContent ?? '')
  const doable = (await detailOf(t2.id)).steps.filter((s) => ['command', 'check', 'wait', 'manual', 'decision', 'delegate'].includes(s.kind)).length
  check('3 进度只数要做的步骤（章节、文字、代码、回显不算）', meta.includes(`/${doable}`), meta)
  const noteRun = await json(A, `/steps/${d.steps.find((s) => s.kind === 'output').id}/run`, 'POST', {})
  check('3 回显块不能运行', noteRun.status === 400, noteRun.body)

  // ── 4 / 7：中文参数名、机器行、参数归到章节 ──────────────────────
  await openTask('用2和3号卡部署')
  await clickText('.params-panel button', '＋ 参数')
  await page.type('.param-add .param-name', '容器名')
  await page.type('.param-add .param-value', 'vllm_test_demo')
  await clickText('.param-add button', '加上')
  await sleep(700)
  await clickText('.params-panel button', '＋ 机器')
  await page.type('.param-add textarea', '10.9.8.195    root    Fake@123')
  await sleep(200)
  await clickText('.param-add button', '加上')
  await sleep(700)
  d = await detailOf(task.id)
  check('4 参数名可以用中文', d.runbook.params.some((p) => p.name === '容器名' && p.value === 'vllm_test_demo'), d.runbook.params)
  const machine = d.runbook.params.find((p) => p.value === '10.9.8.195')
  check('4 "IP 用户 密码" 一行是一个机器参数（原先被拆成三个或存成一整行）', machine?.name === '机器195' && machine.fields?.length === 2 && machine.fields.find((f) => f.key === '密码')?.secret === true, d.runbook.params)
  const step0 = d.steps[0]
  await json(A, `/steps/${step0.id}`, 'PATCH', { rev: step0.rev, command: 'ssh {{机器195.用户}}@{{机器195}} "docker exec -it {{容器名}} bash" # {{机器195.密码}}' })
  await openTask('用2和3号卡部署')
  const cmdText = await page.evaluate(() => document.querySelector('.cmd .code-view')?.textContent ?? '')
  check('4 命令里的 {{机器195.用户}}@{{机器195}}、{{容器名}} 渲染成值，密码显示成圆点', cmdText.includes('root@10.9.8.195') && cmdText.includes('vllm_test_demo') && cmdText.includes('••••••') && !cmdText.includes('Fake@123'), cmdText)
  await clickText('.params-panel button', '全部')
  await sleep(200)
  check('4 密码在参数面板里打码', await page.evaluate(() => [...document.querySelectorAll('.param-field input')].some((i) => i.type === 'password' && i.value === 'Fake@123')))
  // secret 不进团队：配团队后同步上去的命令、说明里没有密码的值
  const sec = (await json(A, `/runbooks/${d.runbook.id}/steps`, 'POST', { parentId: null, afterId: null, step: { kind: 'section', title: '建容器' } })).body.step
  const scoped = (await detailOf(task.id)).runbook.params.map((p) => (p.name === '容器名' ? { ...p, scope: sec.lineageKey } : p))
  await json(A, `/tasks/${task.id}/params`, 'PATCH', { params: scoped })
  await openTask('用2和3号卡部署')
  await clickText('.params-panel button', '全部')
  await sleep(200)
  const groups = await page.evaluate(() => [...document.querySelectorAll('.param-group-title')].map((e) => e.textContent ?? ''))
  check('7 参数可以归到某一章下面（面板里按章节分组）', groups.some((t) => t.includes('建容器')), groups)
  await page.screenshot({ path: join(shots, 'manual-params.png') })

  // 改名：命令里的引用一起换
  const rename = await json(A, `/tasks/${task.id}/params/rename`, 'POST', { from: '容器名', to: '容器' })
  const afterRename = await detailOf(task.id)
  check('4 参数改名，命令里的 {{容器名}} 跟着变', rename.status === 200 && afterRename.steps.some((s) => (s.command ?? '').includes('{{容器}}')) && afterRename.runbook.params.some((p) => p.name === '容器'), afterRename.steps.map((s) => s.command))

  // ── 5：命令框 ────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector('.cmd .code-view')?.click())
  await page.waitForSelector('.code-edit textarea', { timeout: 5000 })
  const h0 = await page.evaluate(() => document.querySelector('.code-edit').getBoundingClientRect().height)
  await page.keyboard.press('End')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('echo more')
  const grown = await page.evaluate(() => {
    const ta = document.querySelector('.code-edit textarea')
    return { h: document.querySelector('.code-edit').getBoundingClientRect().height, resize: getComputedStyle(ta).resize, overflow: ta.scrollHeight - ta.clientHeight }
  })
  check('5 命令框随内容长高、不出内部滚动条', grown.h > h0 + 60 && grown.overflow <= 2, { h0, ...grown })
  check('5 命令框没有右下角的拉伸抓手', grown.resize === 'none', grown.resize)
  await page.keyboard.press('Escape')
  await sleep(300)
  check('5 贴回显的框也没有抓手', (await page.evaluate(() => (document.querySelector('.paste-box') === null ? 'none' : getComputedStyle(document.querySelector('.paste-box')).resize))) === 'none')
  check('5 命令块能标语言', await page.evaluate(() => document.querySelector('.cmd .lang-pick') !== null))
  await page.evaluate(() => document.querySelector('.cmd .fold')?.click())
  await sleep(200)
  check('5 命令块能单独折叠', await page.evaluate(() => document.querySelector('.cmd .code-view') === null))
  await page.evaluate(() => document.querySelector('.cmd .fold')?.click())
  await sleep(200)

  // ── 8：只运行选中的几行 ───────────────────────────────────────
  const s8 = (await detailOf(task.id)).steps.find((s) => s.kind === 'command')
  await json(A, `/steps/${s8.id}`, 'PATCH', { rev: s8.rev, command: 'echo first-line\necho SECOND_LINE\necho third' })
  await openTask('用2和3号卡部署')
  await page.evaluate(() => {
    const pre = document.querySelector('.cmd .code-view')
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
    const nodes = []
    let n
    while ((n = walker.nextNode())) nodes.push(n)
    const full = nodes.map((x) => x.textContent).join('')
    const a = full.indexOf('echo SECOND')
    const b = a + 'echo SECOND_LINE'.length
    const range = document.createRange()
    let off = 0
    for (const x of nodes) {
      const len = x.textContent.length
      if (off <= a && a < off + len) range.setStart(x, a - off)
      if (off < b && b <= off + len) range.setEnd(x, b - off)
      off += len
    }
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    pre.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await sleep(300)
  check('8 选中一行后出现"只运行 / 复制这几行"', await clickText('.cmd .actions button', '▶ 第 2–2 行'))
  await wait(async () => (await page.evaluate(() => document.querySelector('.output-box')?.textContent ?? '')).includes('SECOND_LINE'), 15_000)
  const out = await page.evaluate(() => document.querySelector('.output-box')?.textContent ?? '')
  check('8 只运行了选中的那一行', out.includes('SECOND_LINE') && !out.includes('first-line') && !out.includes('third'), out)
  check('8 只跑几行不改这一步的状态', (await detailOf(task.id)).steps.find((s) => s.id === s8.id).status === 'pending')

  // ── 9：粘贴多行命令 ──────────────────────────────────────────
  await clickText('.add-row button', '＋ 命令')
  await page.waitForSelector('.code-edit textarea', { timeout: 5000 })
  const paste = (t) =>
    page.evaluate((txt) => {
      const ta = document.querySelector('.code-edit textarea')
      const dt = new DataTransfer()
      dt.setData('text/plain', txt)
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, t)
  await paste('docker stop vllm_test_demo\n# 按需重启\ndocker start vllm_test_demo\n# 彻底不需要时可以移除\ndocker rm vllm_test_demo')
  await sleep(300)
  const pasted = await page.evaluate(() => ({ value: document.querySelector('.code-edit textarea')?.value ?? '', offer: document.querySelector('.inline-offer')?.textContent ?? '' }))
  check('9 粘贴后内容就在命令框里（原先框关掉、命令是空的）', pasted.value.includes('docker stop') && pasted.value.includes('docker rm'), pasted)
  check('9 同时问要不要拆成 3 块', pasted.offer.includes('3 条命令'), pasted.offer)
  await page.screenshot({ path: join(shots, 'manual-paste.png') })
  await clickText('.inline-offer button', '拆开')
  await sleep(1200)
  const cmds = (await detailOf(task.id)).steps.filter((s) => (s.command ?? '').startsWith('docker '))
  check('9 拆成 3 步，注释当标题', cmds.length === 3 && cmds[1].title === '按需重启' && cmds[2].title === '彻底不需要时可以移除', cmds.map((c) => [c.title, c.command]))
  await clickText('.add-row button', '＋ 命令')
  await page.waitForSelector('.code-edit textarea', { timeout: 5000 })
  await paste('docker run -itd --name=x \\\n  --shm-size 1g \\\n  image:main')
  await sleep(300)
  check('9 带续行的一条 docker run 不提示拆（原先按行拆成 5 步）', await page.evaluate(() => document.querySelector('.inline-offer') === null))
  await paste('10.9.8.196 root Other@1')
  await page.keyboard.press('Escape')
  await sleep(300)

  // ── 10：右侧面板 ─────────────────────────────────────────────
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.panel-tabs button')].map((b) => b.textContent?.trim() ?? ''))
  check('10 右侧是 这一步 / 问答 / 记录（原先是一条流水账）', ['这一步', '问答', '记录'].every((t) => tabs.some((x) => x.startsWith(t))), tabs)
  await clickText('.panel-tabs button', '记录')
  await sleep(200)
  const log = await page.evaluate(() => [...document.querySelectorAll('.qb-feed .qb-msg')].map((m) => m.textContent).join(' | '))
  check('10 记录默认不显示编辑、插入这类流水账', !/插入|改了.*的(命令|正文|标题)/.test(log), log.slice(0, 300))
  await clickText('.panel-tabs button', '这一步')

  // ── 12：问答 ─────────────────────────────────────────────────
  await page.evaluate(() => [...document.querySelectorAll('.here-label button')].find((b) => (b.textContent ?? '').includes('记一条'))?.click())
  await page.waitForSelector('.qb-panel .lesson-form textarea', { timeout: 5000 })
  await page.type('.qb-panel .lesson-form textarea', '权重一般放在哪？')
  await clickText('.qb-panel .lesson-form button', '只记给自己')
  await sleep(800)
  let qa = (await json(A, `/tasks/${task.id}/qa`, 'GET')).body.items
  check('12 只写问、不写答也能记（原先症状和修法都要填）', qa.some((q) => q.question === '权重一般放在哪？' && q.answer === ''), qa)
  await json(A, `/tasks/${task.id}/qa`, 'POST', { question: '', answer: '双卡启动大概要 4-6 分钟', stepId: null })
  qa = (await json(A, `/tasks/${task.id}/qa`, 'GET')).body.items
  check('12 只写答（一条经验）挂在整份文档上', qa.some((q) => q.stepId === null && q.answer.includes('4-6 分钟')), qa)
  // 问发起人 → 回答填回问答
  await json(A, '/settings/team', 'POST', { url: team.url, token: ua.token, enabled: true })
  const open = qa.find((q) => q.question === '权重一般放在哪？')
  const ask = await json(A, `/tasks/${task.id}/ask`, 'POST', { stepId: open.stepId, body: '权重一般放在哪？', lessonId: open.id })
  check('12 没答案的问答可以拿去问发起人', ask.status === 202 && ask.body?.sent === true, ask.body)
  const question = await wait(async () => ((await json(team.url, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.questions ?? []).some((q) => q.answer === null), 20_000)
  const qid = ((await json(team.url, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.questions ?? []).find((q) => q.answer === null)?.id
  await json(team.url, `/api/questions/${qid}/answer`, 'POST', { answer: '一般在 /home/weight 下面' }, pl.token)
  const filled = await wait(async () => ((await json(A, `/tasks/${task.id}/qa`, 'GET')).body.items ?? []).some((q) => q.id === open.id && q.answer.includes('/home/weight')), 20_000)
  check('12 发起人的回答自动填进这条问答的"答"', question && filled)
  await openTask('用2和3号卡部署')
  await clickText('.panel-tabs button', '问答')
  await sleep(300)
  const qaTab = await page.evaluate(() => document.querySelector('.qb-feed')?.textContent ?? '')
  check('12 问答栏能看到整份文档的和各步的问答', qaTab.includes('权重一般放在哪') && qaTab.includes('4-6 分钟'), qaTab.slice(0, 300))
  await page.screenshot({ path: join(shots, 'manual-qa.png') })

  // 旧的"失败后修好 → 记成坑"还在，只是不再强制症状+修法
  const s12 = (await detailOf(task.id)).steps.find((s) => s.kind === 'command')
  const onlyQ = await json(A, `/steps/${s12.id}/lesson`, 'POST', { symptom: '只有问题没有修法' })
  check('12 在某一步上记问答也不强制两个都填', onlyQ.status === 201, onlyQ.body)

  // ── 6：回显 ──────────────────────────────────────────────────
  const s6 = (await detailOf(task.id)).steps.find((s) => s.id === s8.id)
  await json(A, `/steps/${s6.id}/reference`, 'POST', { text: 'first-line\nSECOND_LINE\nthird' })
  await json(A, `/steps/${s6.id}/run`, 'POST', {})
  await wait(async () => (await detailOf(task.id)).steps.find((s) => s.id === s6.id).status === 'ok', 15_000)
  const outs = (await json(A, `/steps/${s6.id}/outputs`, 'GET')).body
  check('6 参考回显存下了，历次回显都留着', (outs.reference ?? '').includes('SECOND_LINE') && outs.mine.length >= 2, outs)
  await openTask('用2和3号卡部署')
  await page.evaluate(() => document.querySelector('.step')?.click())
  await sleep(300)
  await page.evaluate(() => [...document.querySelectorAll('.lesson-fold')].find((b) => (b.textContent ?? '').startsWith('回显对比'))?.click())
  await wait(async () => page.evaluate(() => document.querySelectorAll('.diff-view > div').length >= 3), 10_000)
  const diff = await page.evaluate(() => document.querySelector('.history-head')?.textContent ?? '')
  check('6 回显对比：参考回显 vs 这次，逐行比', diff.includes('完全一样') || diff.includes('行不一样'), diff)
  // 别的任务里同一步的回显也能比（挑步骤拼过来的，血缘相同）
  const t4 = (await json(A, '/tasks', 'POST', { title: '拼接：复用上一个任务的步骤' })).body
  const g = await json(A, `/tasks/${t4.id}/graft`, 'POST', { sourceTaskId: task.id, stepIds: [s6.id] })
  const t4d = await detailOf(t4.id)
  const other = (await json(A, `/steps/${t4d.steps[0].id}/outputs`, 'GET')).body
  check('1 从别的任务挑一步拼进来（血缘保留，状态不带）', g.status === 201 && t4d.steps[0].lineageKey === s6.lineageKey && t4d.steps[0].status === 'pending', t4d.steps)
  check('6 拼过来的步骤能看到原任务里跑出来的回显', other.others.some((o) => (o.text ?? '').includes('SECOND_LINE')), other)
  // 挑整章
  const src = await detailOf(t2.id)
  const chapter = src.steps.find((s) => s.kind === 'section' && s.title === '创建vllm-ascend的docker')
  const t5 = (await json(A, '/tasks', 'POST', { title: '拼接：只要建容器那一章' })).body
  await json(A, `/tasks/${t5.id}/graft`, 'POST', { sourceTaskId: t2.id, stepIds: [chapter.id] })
  const t5d = await detailOf(t5.id)
  check('1 挑一整章拼进来（连同里面的命令和说明）', t5d.steps[0]?.title === '创建vllm-ascend的docker' && t5d.steps.length >= 4, t5d.steps.map((s) => s.title))

  // ── 11：树形 ─────────────────────────────────────────────────
  const tree = await detailOf(task.id)
  const tops = tree.steps.filter((s) => s.parentId === null && s.kind === 'command')
  const mv = await json(A, `/steps/${tops[1].id}/move`, 'POST', { rev: tops[1].rev, parentId: tops[0].id, afterId: null })
  check('11 步骤可以挂到另一步下面（子步骤）', mv.status === 200, mv.body)
  const secNow = (await detailOf(task.id)).steps.find((s) => s.kind === 'section')
  const bad = await json(A, `/steps/${secNow.id}/move`, 'POST', { rev: secNow.rev, parentId: tops[0].id, afterId: null })
  check('11 章节不能挂到步骤下面', bad.status === 400, bad.body)
  await openTask('用2和3号卡部署')
  check('11 正文按层级缩进', (await page.evaluate(() => [...document.querySelectorAll('.runbook .step')].map((e) => e.style.marginLeft))).includes('18px'))
  // 折叠章节
  await openTask('导入：部署笔记')
  const before = await page.evaluate(() => document.querySelectorAll('.runbook .step, .runbook .block').length)
  await page.evaluate(() => [...document.querySelectorAll('.section-head')].find((h) => (h.textContent ?? '').includes('命令'))?.querySelector('.fold')?.click())
  await sleep(300)
  const after = await page.evaluate(() => document.querySelectorAll('.runbook .step, .runbook .block').length)
  check('11 章节能折叠', after < before, { before, after })

  // ── 13：导出 markdown ────────────────────────────────────────
  await page.evaluate(() => [...document.querySelectorAll('.header-actions .more > .btn')].find((b) => b.textContent?.trim() === '⋯')?.click())
  await sleep(200)
  check('13 手册能导出 markdown（顶栏 ⋯）', await page.evaluate(() => [...document.querySelectorAll('.menu-item')].some((b) => b.textContent?.includes('导出 markdown'))))

  // secret 不出本机：同步到团队的镜像里没有密码的值
  await wait(async () => ((await json(team.url, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body?.steps ?? []).length > 0, 20_000)
  const mirror = JSON.stringify((await json(team.url, `/api/tasks/${task.id}`, 'GET', undefined, pl.token)).body)
  check('4 密码不出本机（团队镜像里没有它）', !mirror.includes('Fake@123') && !mirror.includes('Other@1'))

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
