/**
 * 告警推送：通用 webhook 与外部命令（Python 脚本）。
 *
 * 出告警时按渠道过滤（min_level、启用、免打扰时段）逐个发：
 * - webhook：POST 一个 JSON（含纯文本字段 text），期望 2xx，超时 10s
 * - command：spawn 配置的命令，JSON 走 stdin，纯文本放 QB_ALERT_TEXT；
 *   失败不重试（脚本事例自己写），只把退出码记进结果
 */

import { spawn } from 'node:child_process'
import type { AlertRow, PushChannel, TaskMirror, TeamStore } from './store.ts'

export interface PushContext {
  alert: AlertRow
  task: TaskMirror
  stepTitle: string | null
}

export interface PushOutcome {
  channelId: string
  channelName: string
  ok: boolean
  detail: string
}

/** 免打扰时段（本地时钟，HH:MM）。跨越零点写 start > end。 */
export interface QuietHours {
  start: string
  end: string
  enabled: boolean
}

export function inQuietHours(now: Date, qh: QuietHours | null): boolean {
  if (qh === null || !qh.enabled) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh = 0, sm = 0] = qh.start.split(':').map(Number)
  const [eh = 0, em = 0] = qh.end.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

/** 渠道要不要吃这条告警。 */
export function channelWants(ch: PushChannel, alert: AlertRow): boolean {
  if (!ch.enabled) return false
  return ch.minLevel === 'yellow' ? true : alert.level === 'red'
}

export function pushText(ctx: PushContext): string {
  const head = ctx.alert.level === 'red' ? '🔴' : '🟡'
  const step = ctx.stepTitle !== null ? `「${ctx.stepTitle}」` : ''
  return `${head} ${ctx.task.title}：${ctx.alert.message}${step !== '' ? `（${step}）` : ''} · QB`
}

/** 向所有匹配的渠道推一条告警，返回每个渠道的结果。 */
export async function pushAlert(store: TeamStore, ctx: PushContext): Promise<PushOutcome[]> {
  const channels = store.listChannels()
  const quiet = inQuietHours(new Date(), store.getSetting<QuietHours>('quietHours'))
  const out: PushOutcome[] = []
  for (const ch of channels) {
    if (!channelWants(ch, ctx.alert)) continue
    if (quiet && ctx.alert.level !== 'red') continue // 免打扰时只放行红
    try {
      out.push(ch.kind === 'webhook' ? await pushWebhook(ch, ctx) : await pushCommand(ch, ctx))
    } catch (e) {
      out.push({ channelId: ch.id, channelName: ch.name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

async function pushWebhook(ch: PushChannel, ctx: PushContext): Promise<PushOutcome> {
  const url = typeof ch.config.url === 'string' ? ch.config.url : ''
  if (url === '') return { channelId: ch.id, channelName: ch.name, ok: false, detail: '渠道没配置 url' }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(typeof ch.config.header === 'object' && ch.config.header !== null ? (ch.config.header as Record<string, string>) : {}),
    },
    body: JSON.stringify({ text: pushText(ctx), level: ctx.alert.level, type: ctx.alert.type, task: { id: ctx.task.id, title: ctx.task.title } }),
    signal: AbortSignal.timeout(10_000),
  })
  // 目标的响应体不回显给调用者：那会变成"读任意内网地址"的原语
  if (!res.ok) void res.text().catch(() => '')
  return {
    channelId: ch.id,
    channelName: ch.name,
    ok: res.ok,
    detail: `HTTP ${res.status}`,
  }
}

/** 外部命令：JSON 进 stdin，纯文本进 QB_ALERT_TEXT。给 Python 脚本用。 */
function pushCommand(ch: PushChannel, ctx: PushContext): Promise<PushOutcome> {
  const command = typeof ch.config.command === 'string' ? ch.config.command : ''
  if (command.trim() === '') return Promise.resolve({ channelId: ch.id, channelName: ch.name, ok: false, detail: '渠道没配置 command' })

  const text = pushText(ctx)
  return new Promise((resolve) => {
    // 用 shell 解释：允许直接写 "python push.py --webhook x" 这类带参数的命令；
    // 纯文本走环境变量——脚本里 os.environ['QB_ALERT_TEXT'] 即可
    const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, QB_ALERT_TEXT: text } })
    let stderr = ''
    const timer = setTimeout(() => child.kill(), 15_000)

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString().slice(0, 300)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ channelId: ch.id, channelName: ch.name, ok: false, detail: `启动失败：${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const ok = code === 0
      resolve({
        channelId: ch.id,
        channelName: ch.name,
        ok,
        detail: ok ? `退出码 0` : `退出码 ${code}${stderr !== '' ? `：${stderr}` : ''}`,
      })
    })

    child.stdin.end(
      JSON.stringify({
        text,
        level: ctx.alert.level,
        type: ctx.alert.type,
        task: { id: ctx.task.id, title: ctx.task.title },
      }),
    )
  })
}

/** 测试渠道（设置页的"测试"按钮）。 */
export function testChannel(ch: PushChannel): Promise<PushOutcome> {
  const fakeAlert: AlertRow = {
    key: 'test:test',
    taskId: 't_test',
    stepId: null,
    level: 'red',
    type: 'test',
    message: '这是一条测试告警（QB 设置页发出）',
    count: 1,
    status: 'open',
    ackedBy: null,
    ackedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const fakeTask: TaskMirror = {
    id: 't_test',
    title: '测试任务',
    briefMd: '',
    initiatorName: '',
    assigneeName: '',
    status: 'active',
    parentStepId: null,
    expectedMinutes: null,
    startedAt: null,
    endedAt: null,
    runbookVersion: null,
    updatedAt: Date.now(),
  }
  return (ch.kind === 'webhook' ? pushWebhook(ch, { alert: fakeAlert, task: fakeTask, stepTitle: null }) : pushCommand(ch, { alert: fakeAlert, task: fakeTask, stepTitle: null }))
}
