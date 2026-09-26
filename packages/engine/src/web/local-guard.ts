/**
 * 本机引擎的请求守卫。
 *
 * 引擎只监听回环地址，但浏览器里任意网页都能向 127.0.0.1 发请求：
 * - 跨站请求（CSRF）：text/plain 之类的"简单请求"不触发预检，服务端照单全收；
 * - DNS rebinding：恶意域名解析到 127.0.0.1 后，浏览器视为同源，连响应都能读；
 * - 跨站 WebSocket：任意网页都能连上来读广播（步骤输出）。
 * 引擎能执行命令、存着模型 key，这几条都必须挡住。
 *
 * 规则：Host 必须是本机地址；带 Origin 的请求 Origin 也必须是本机；
 * 写操作必须是 application/json（跨站发它要先预检，而我们不回 CORS 头）。
 * 不带 Origin 的请求来自本机脚本（curl、冒烟测试），放行。
 */

import type { IncomingMessage } from 'node:http'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export interface LocalGuard {
  http(req: IncomingMessage): string | null
  upgrade(req: IncomingMessage): string | null
}

/** @param extraHosts 另外允许的主机名（dsh 配置里的监听地址）。 */
export function createLocalGuard(extraHosts: () => string[] = () => []): LocalGuard {
  const allowed = (hostname: string | null): boolean =>
    hostname !== null && (LOOPBACK.has(hostname) || extraHosts().includes(hostname))

  const checkHostAndOrigin = (req: IncomingMessage): string | null => {
    const host = req.headers.host
    const hostName = hostnameOf(host)
    if (!allowed(hostName)) return `拒绝：Host ${host ?? '(空)'} 不是本机地址`

    const origin = req.headers.origin
    if (origin === undefined) return null
    if (origin === 'null') return '拒绝：来源不明的请求'
    if (!allowed(hostnameOfUrl(origin))) return `拒绝：来自 ${origin} 的跨站请求`
    // 端口也要对上：本机其他端口上的页面同样不该读我们的数据（写路径
    // 有 content-type 挡着，但 WS 广播和 GET 读取只靠这一层）
    if (portOfUrl(origin) !== portOf(host)) return `拒绝：来自 ${origin} 的跨端口请求`
    return null
  }

  return {
    http(req) {
      const bad = checkHostAndOrigin(req)
      if (bad !== null) return bad
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase()
        if (!ct.startsWith('application/json')) return '拒绝：写操作的请求体必须是 application/json'
      }
      return null
    },
    upgrade(req) {
      return checkHostAndOrigin(req)
    },
  }
}

/**
 * "127.0.0.1:3080" → "127.0.0.1"；"[::1]:3080" → "[::1]"。
 * 用 URL 解析而不是切分：`localhost:3080@evil.com` 这种带 userinfo 的
 * Host 头，按冒号切会把 "localhost" 当主机名，实际指向的是 evil.com。
 */
function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader === '') return null
  try {
    const h = new URL(`http://${hostHeader}`).hostname.toLowerCase()
    // Node 的 URL 对 IPv6 主机名保留方括号；没带的补上，统一成 [::1] 形式
    return h.includes(':') ? (h.startsWith('[') ? h : `[${h}]`) : h
  } catch {
    return null
  }
}

/** "127.0.0.1:3080" → 3080；没写端口返回 null（由调用方按 80 对齐）。 */
function portOf(hostHeader: string | undefined): number | null {
  if (hostHeader === undefined || hostHeader === '') return null
  try {
    return new URL(`http://${hostHeader}`).port === '' ? null : Number(new URL(`http://${hostHeader}`).port)
  } catch {
    return null
  }
}

function portOfUrl(origin: string): number | null {
  try {
    const p = new URL(origin).port
    return p === '' ? null : Number(p)
  } catch {
    return null
  }
}

function hostnameOfUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
  } catch {
    return null
  }
}
