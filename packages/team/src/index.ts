/**
 * @qb/team 启动器：HTTP + WS + 远程 UI 静态托管。
 *
 * 用法（Windows / Linux 都一样，只要 Node ≥22）：
 *   node --experimental-strip-types packages/team/src/index.ts \
 *        --db team.db --port 3777 --ui packages/ui/dist
 *
 * 首次启动：没有用户时自动发一张邀请（打印一次，之后不再出现），
 * 浏览器打开 http://<host>:<port>/#/join/<邀请码> 注册并拿个人令牌。
 * 执行引擎侧：把该用户的令牌填进 QB「设置 · 团队」。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { openDb } from './db.ts'
import { createApp } from './api.ts'
import { TeamStore } from './store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

const dbPath = arg('db', join(HERE, '../../data', 'team.db'))
const port = Number(arg('port', '3777'))
const host = arg('host', '0.0.0.0') // 内网机器上要能被同事访问；要只本机用就 --host 127.0.0.1
const uiDir = arg('ui', join(HERE, '../../ui/dist'))

const store = new TeamStore(openDb({ path: dbPath }))

// 远程 UI 的实时刷新：所有已认证连接收 refresh 广播（带 taskId 增量）
const clients = new Set<import('ws').WebSocket>()
function broadcast(taskIds: string[]): void {
  const msg = JSON.stringify({ type: 'refresh', taskIds })
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg)
  }
}

const app = createApp({
  store,
  onIngest: broadcast,
  onComment: (taskId) => broadcast([taskId]),
  onAnswer: (taskId) => broadcast([taskId]),
  onAck: (taskId) => broadcast([taskId]),
})

// 远程 UI 静态托管（同一份构建产物，基地址是相对的）。
// /assets/* 这类真文件必须以正确的 Content-Type 返回——全部回 index.html
// 会让 <script> 因 MIME 不符被浏览器拒载（白屏）。
const indexHtml = existsSync(join(uiDir, 'index.html')) ? readFileSync(join(uiDir, 'index.html'), 'utf8') : null
if (existsSync(uiDir)) {
  // serve-static 的 root 要相对 cwd 的路径。
  // UI 构建的 base 是 /qb/（绝对路径），所以团队服务也要在 /qb/assets 下
  // 托管——同一份产物同时服务 "/"（远程首页）和 "/qb/*"（引擎路径）。
  const relRoot = relative(process.cwd(), uiDir).replaceAll('\\', '/')
  app.use('/qb/assets/*', serveStatic({ root: relRoot }))
  app.get('/qb/favicon.ico', serveStatic({ root: relRoot }))
}
app.get('*', (c) => {
  if (indexHtml === null) {
    return c.text(`远程 UI 未找到（--ui ${uiDir}）。先 pnpm --filter @qb/ui build。`, 500)
  }
  return c.html(indexHtml)
})
// 引擎路径 /qb/ 也要能到达远程 UI（入口选择在 main.tsx 里按 pathname 分流）
app.get('/qb/*', (c) => c.html(indexHtml))

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[qb-team] 监听 http://${host}:${info.port}（数据库 ${dbPath}）`)
})

// WS：浏览器令牌走查询参数（浏览器 WS 设不了请求头）
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  const token = new URLSearchParams(url.search).get('token') ?? ''
  if (store.userByToken(token) === null) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    // 客户端回 pong 即视为活跃
    ws.on('pong', () => ((ws as unknown as { __missed?: number }).__missed = 0))
  })
})

// 心跳：30 秒 ping 一轮，连续 3 次无回应就踢——死连接会堆积、慢连接会占内存
setInterval(() => {
  for (const ws of clients) {
    const state = ws as unknown as { __missed?: number; terminate(): void }
    const missed = (state.__missed ?? 0) + 1
    if (missed > 3) {
      ws.terminate()
      clients.delete(ws)
      continue
    }
    state.__missed = missed
    ws.ping()
  }
}, 30_000).unref?.()

// 首次启动：没有用户时发一张邀请，打印一次加入链接
if (!store.hasUsers()) {
  const invite = store.createInvite(24 * 60 * 60_000, 3)
  console.log('')
  console.log('════════════════════════════════════════════════════════')
  console.log('  还没有用户。第一位从这里注册（24 小时内有效，可 3 次）：')
  console.log(`  http://<这台机器的IP>:${port}/#/join/${invite}`)
  console.log('  注册后把个人令牌填进执行端的「设置 · 团队」。')
  console.log('════════════════════════════════════════════════════════')
}

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})
