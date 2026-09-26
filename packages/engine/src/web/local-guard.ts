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
    if (!allowed(hostnameOf(host))) return `拒绝：Host ${host ?? '(空)'} 不是本机地址`

    const origin = req.headers.origin
    if (origin === undefined) return null
    if (origin === 'null') return '拒绝：来源不明的请求'
    if (!allowed(hostnameOfUrl(origin))) return `拒绝：来自 ${origin} 的跨站请求`
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

/** "127.0.0.1:3080" → "127.0.0.1"；"[::1]:3080" → "[::1]"。 */
function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader === '') return null
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end < 0 ? null : hostHeader.slice(0, end + 1)
  }
  return hostHeader.split(':')[0]!.toLowerCase()
}

function hostnameOfUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
  } catch {
    return null
  }
}
