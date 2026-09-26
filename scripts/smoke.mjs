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
  // 冒烟不连真实模型：去掉 QB_LLM_*，结果才可重复（也验证"没配模型"时的报错）
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QB_LLM_')))
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
    { env: { ...env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'] },
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
        {
          kind: 'command',
          title: '验证大输出被截断',
          command: 'node -e "process.stdout.write(\'x\'.repeat(300000))"',
          timeoutMs: 30000,
        },
        {
          kind: 'command',
          title: '验证参数渲染',
          command: 'echo "hello {{WHO}}"',
          expectation: { kind: 'contains', text: 'hello qb', caseSensitive: true },
          timeoutMs: 15000,
        },
      ],
    }),
  })
  const rb = await rbRes.json()
  check('能写入 runbook', rbRes.status === 201 && rb.steps?.length === 5, JSON.stringify(rb).slice(0, 200))

  const [okStep, timeoutStep, dangerStep, bigStep, whoStep] = rb.steps ?? []

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

  // 4.5) 大文本：粘贴 300KB，落库截到尾部 64KB 并注明
  //     （自动执行路径看不到这条——dsh 自己先把输出截到 64KB）
  if (bigStep !== undefined) {
    const pasted = await fetch(`${API}/steps/${bigStep.id}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(300000) }),
    })
    const bigDetail = await (await fetch(`${API}/tasks/${task.id}/runbook`)).json()
    const bigEvidence = (bigDetail.evidence[bigStep.id] ?? []).at(-1)
    check(
      '大输出截断落库',
      pasted.status === 201 &&
        typeof bigEvidence?.text === 'string' &&
        bigEvidence.text.startsWith('……（前面') &&
        bigEvidence.text.length <= 64 * 1024 + 60,
      `len=${bigEvidence?.text?.length} 开头=${bigEvidence?.text?.slice(0, 20)}`,
    )
  }

  // 4.6) 超大请求体：413 而不是 500
  const tooBig = await fetch(`${API}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(9 * 1024 * 1024),
  })
  check('请求体超限回 413', tooBig.status === 413, `status ${tooBig.status}`)

  // ── M6：原地编辑 ────────────────────────────────────────
  const json = (method, path, body) =>
    fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const detailOf = async () => (await fetch(`${API}/tasks/${task.id}/runbook`)).json()

  const edited = await json('PATCH', `/steps/${okStep.id}`, { rev: 0, command: 'echo QB_EDITED' })
  const editedBody = await edited.json()
  check(
    '编辑：原地修改，rev +1，记下是谁改的',
    edited.status === 200 && editedBody.step?.command === 'echo QB_EDITED' && editedBody.step?.rev === 1 && editedBody.step?.editedBy === me.id,
    JSON.stringify(editedBody).slice(0, 200),
  )
  const stale = await json('PATCH', `/steps/${okStep.id}`, { rev: 0, command: 'echo stale' })
  const staleBody = await stale.json()
  check('编辑：rev 过期时 409 并带回最新内容', stale.status === 409 && staleBody.step?.command === 'echo QB_EDITED', JSON.stringify(staleBody).slice(0, 200))

  const afterEdit = await detailOf()
  check(
    '编辑：时间线里有改前改后',
    afterEdit.events.some(
      (e) => e.kind === 'edit' && e.payload.changes?.some((c) => c.field === 'command' && c.after === 'echo QB_EDITED'),
    ),
  )

  const inserted = await json('POST', `/runbooks/${rb.runbook.id}/steps`, {
    parentId: null,
    afterId: okStep.id,
    step: { kind: 'command', title: '插入的步骤', command: 'echo inserted' },
  })
  const insertedStep = (await inserted.json()).step
  let titles = (await detailOf()).steps.map((s) => s.title)
  check('插入：落在指定位置', inserted.status === 201 && titles[1] === '插入的步骤', JSON.stringify(titles))

  const moved = await json('POST', `/steps/${insertedStep.id}/move`, { rev: 0, parentId: null, afterId: null })
  titles = (await detailOf()).steps.map((s) => s.title)
  check('移动：挪到最前', moved.status === 200 && titles[0] === '插入的步骤', JSON.stringify(titles))

  const deleted = await json('DELETE', `/steps/${insertedStep.id}`)
  titles = (await detailOf()).steps.map((s) => s.title)
  check('删除：从文档里消失', deleted.status === 200 && !titles.includes('插入的步骤'), JSON.stringify(titles))
  const restored = await json('POST', `/steps/${insertedStep.id}/restore`)
  titles = (await detailOf()).steps.map((s) => s.title)
  check('撤销删除：回到原位', restored.status === 200 && titles[0] === '插入的步骤', JSON.stringify(titles))

  const skipped = await json('POST', `/steps/${timeoutStep.id}/status`, { status: 'skipped', note: '这台机器上不需要' })
  const afterSkip = (await detailOf()).steps.find((s) => s.id === timeoutStep.id)
  check('跳过：带一句原因', skipped.status === 200 && afterSkip?.status === 'skipped' && afterSkip?.statusNote === '这台机器上不需要', JSON.stringify(afterSkip))

  // ── M6：截图证据 ─────────────────────────────────────────
  const RED_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC'
  const shot = await json('POST', `/steps/${insertedStep.id}/evidence`, { imageBase64: `data:image/png;base64,${RED_PNG}`, mediaType: 'image/png' })
  const shotBody = await shot.json()
  const withShot = await detailOf()
  const imageEvidence = (withShot.evidence[insertedStep.id] ?? []).find((e) => e.imagePath !== null)
  check('截图：存盘并记为证据', shot.status === 201 && imageEvidence !== undefined, JSON.stringify(shotBody))
  if (imageEvidence !== undefined) {
    const img = await fetch(`${API}/evidence/${imageEvidence.id}/image`)
    const bytes = Buffer.from(await img.arrayBuffer())
    check(
      '截图：刷新后还能取回原图',
      img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.equals(Buffer.from(RED_PNG, 'base64')),
      `status ${img.status} ${img.headers.get('content-type')} ${bytes.length}B`,
    )
  }
  const badShot = await json('POST', `/steps/${insertedStep.id}/evidence`, { imageBase64: 'AAAA', mediaType: 'image/tiff' })
  check('截图：不支持的格式明确拒绝', badShot.status === 400)

  // ── M6：本机守卫（挡跨站请求与 DNS rebinding）───────────────
  const plain = await fetch(`${API}/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ title: 'csrf' }) })
  check('守卫：text/plain 的写请求被拒（跨站"简单请求"）', plain.status === 403, `status ${plain.status}`)
  const cross = await fetch(`${API}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ title: 'csrf' }),
  })
  check('守卫：跨站 Origin 被拒', cross.status === 403, `status ${cross.status}`)

  // ── M7：参数 ────────────────────────────────────────────
  const setParamsRes = await json('PATCH', `/tasks/${task.id}/params`, {
    params: [{ name: 'WHO', value: 'qb', source: 'origin' }],
  })
  const setParams = { status: setParamsRes.status, body: await setParamsRes.json().catch(() => null) }
  check('参数：写入参数表', setParams.status === 200 && setParams.body?.params?.[0]?.name === 'WHO', JSON.stringify(setParams.body ?? null).slice(0, 120))

  const whoRun = await fetch(`${API}/steps/${whoStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('参数：运行前按参数表渲染（{{WHO}} → qb）', whoRun.status === 202, `status ${whoRun.status}`)
  await waitFor(() => wsEvents.some((e) => e.type === 'step.done' && e.stepId === whoStep.id), 30_000)
  const whoDone = wsEvents.find((e) => e.type === 'step.done' && e.stepId === whoStep.id)
  if (whoDone?.verdict !== 'pass') {
    const dbg = await (await fetch(`${API}/tasks/${task.id}/runbook`)).json()
    console.log(
      'who 调试: params=',
      JSON.stringify(dbg.runbook?.params),
      ' cmd=',
      JSON.stringify(dbg.steps.find((s) => s.id === whoStep.id)?.command),
      ' 证据=',
      JSON.stringify((dbg.evidence[whoStep.id] ?? []).at(-1)?.text?.slice(0, 80)),
    )
  }
  check('参数：渲染后的命令按预期判定通过', whoDone?.verdict === 'pass', JSON.stringify(whoDone ?? null))

  const clearParams = await json('PATCH', `/tasks/${task.id}/params`, {
    params: [{ name: 'WHO', value: '' }],
  })
  void clearParams
  const missingRun = await fetch(`${API}/steps/${whoStep.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const missingBody = await missingRun.json()
  check(
    '参数：缺值时拒绝运行（不能把 {{WHO}} 发给 shell）',
    missingRun.status === 400 && missingBody.error === 'missing_params' && missingBody.missing?.includes('WHO'),
    JSON.stringify(missingBody).slice(0, 120),
  )
  await json('PATCH', `/tasks/${task.id}/params`, { params: [{ name: 'WHO', value: 'qb' }] })

  // ── M7：终端分流（L0.5）──────────────────────────────────
  const transcriptRes = await json('POST', `/tasks/${task.id}/transcript`, {
    text: 'Last login: Sun\n[root@gpu-17 ~]# echo QB_EDITED\nQB_EDITED\n[root@gpu-17 ~]# free -g\n              total\n1',
  })
  const transcript = { status: transcriptRes.status, body: await transcriptRes.json().catch(() => null) }
  check('终端分流：按命令匹配回步骤', transcript.status === 200 && transcript.body?.matched === 1, JSON.stringify(transcript.body ?? null))
  const afterTranscript = await detailOf()
  const okEvidence = (afterTranscript.evidence[okStep.id] ?? []).filter((e) => e.source === 'paste')
  check('终端分流：输出成为该步证据', okEvidence.some((e) => (e.text ?? '').includes('QB_EDITED')), JSON.stringify(okEvidence.map((e) => e.text?.slice(0, 30))))

  // ── M7：底稿 ────────────────────────────────────────────
  const bases = await (await fetch(`${API}/tasks/suggest-bases?q=${encodeURIComponent('PD 分离 vllm')}`)).json()
  check('找底稿：能按标题检索到任务', bases.suggestions?.some((b) => b.taskId === task.id), JSON.stringify(bases.suggestions ?? []).slice(0, 160))

  const task2 = await (await json('POST', '/tasks', { title: '在 Y 集群跑同样的部署' })).json()
  const copiedRes = await fetch(`${API}/tasks/${task2.id}/based-on`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runbookId: rb.runbook.id }),
  })
  const copied = { status: copiedRes.status, body: await copiedRes.json().catch(() => null) }
  if (copied.status !== 201) console.log('based-on 失败:', copied.status, JSON.stringify(copied.body).slice(0, 300))
  const copiedDetail = await (await fetch(`${API}/tasks/${task2.id}/runbook`)).json()
  const srcStep = copiedDetail.steps.find((s) => s.title === '验证参数渲染')
  check(
    '以底稿为基础：步骤与参数都复制过来，血缘保留',
    copied.status === 201 &&
      srcStep?.command === 'echo "hello {{WHO}}"' &&
      copiedDetail.runbook?.params?.some((p) => p.name === 'WHO' && p.source === 'base') &&
      srcStep?.lineageKey === whoStep.lineageKey,
    `steps=${copiedDetail.steps.length} params=${JSON.stringify(copiedDetail.runbook?.params)}`,
  )

  // ── M6：模型设置 ─────────────────────────────────────────
  const settings0 = await (await fetch(`${API}/settings/llm`)).json()
  check('设置：没配模型时如实说明', settings0.status?.structure?.ok === false && settings0.presets?.length >= 6, JSON.stringify(settings0.status))
  const savedProfile = await json('POST', '/settings/llm/profiles', {
    preset: 'custom-openai',
    wire: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'fake-model',
    apiKey: 'sk-smoke-secret-0000',
  })
  const savedBody = await savedProfile.json()
  check(
    '设置：保存档案，key 只回打码后的样子',
    savedProfile.status === 201 && savedBody.profile?.keyHint !== '' && !JSON.stringify(savedBody).includes('sk-smoke-secret-0000'),
    JSON.stringify(savedBody.profile),
  )
  check('设置：第一个档案自动成为各用途的默认', savedBody.purposes?.structure === savedBody.profile?.id)
  const onePurpose = await json('POST', '/settings/llm/purposes', { diagnose: null })
  const onePurposeBody = await onePurpose.json()
  check(
    '设置：只改一个用途，其余不动',
    onePurpose.status === 200 && onePurposeBody.purposes?.diagnose === undefined && onePurposeBody.purposes?.structure === savedBody.profile?.id,
    JSON.stringify(onePurposeBody.purposes ?? onePurposeBody),
  )
  const removed = await json('DELETE', `/settings/llm/profiles/${savedBody.profile?.id}`)
  check('设置：删除档案', removed.status === 200)

  // 没有模型时起草：明确说"还没有配置模型"，不静默失败
  await json('POST', `/tasks/${task.id}/draft`)
  await waitFor(() => wsEvents.some((e) => e.type === 'job.update' && e.job.kind === 'draft' && e.job.status === 'failed'), 15_000)
  const draftFail = wsEvents.find((e) => e.type === 'job.update' && e.job.kind === 'draft' && e.job.status === 'failed')
  check('起草：没配模型时报错说清楚', /还没有配置模型/.test(draftFail?.job?.error ?? ''), JSON.stringify(draftFail ?? null))

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
