import type { IncomingMessage, ServerResponse } from 'node:http'

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>

export interface RouteContext {
  /** 去掉挂载前缀后的路径，如 /tasks/tsk_x。 */
  path: string
  params: Record<string, string>
  query: URLSearchParams
  /** 解析后的 JSON body（仅 POST/PATCH/PUT）。 */
  body: unknown
}

interface Route {
  method: string
  /** 形如 /tasks/:id/run 的模式。 */
  pattern: string
  segments: string[]
  handler: Handler
}

/**
 * 极简路由器。
 *
 * 不引 Hono 之类的框架：这一层只在 dsh 的 node:http 之上分发十几条路由，
 * 框架带来的依赖和构建复杂度不划算。团队服务那边另论。
 *
 * 注意：不能用构造函数参数属性——dsh 以 Node strip-only 模式加载插件源码。
 */
export class Router {
  private routes: Route[] = []
  private readonly mountPath: string

  constructor(mountPath: string) {
    this.mountPath = mountPath
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  get(p: string, h: Handler): this {
    return this.add('GET', p, h)
  }
  post(p: string, h: Handler): this {
    return this.add('POST', p, h)
  }
  patch(p: string, h: Handler): this {
    return this.add('PATCH', p, h)
  }

  /** 交给 dsh 的 webServer.register 的处理函数。 */
  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.startsWith(this.mountPath)
        ? url.pathname.slice(this.mountPath.length) || '/'
        : url.pathname

      const segments = path.split('/').filter(Boolean)
      const method = req.method ?? 'GET'

      for (const route of this.routes) {
        if (route.method !== method) continue
        const params = matchSegments(route.segments, segments)
        if (params === null) continue

        const body = await readBody(req)
        await route.handler(req, res, { path, params, query: url.searchParams, body })
        return
      }

      sendJson(res, 404, { error: 'not_found', path })
    } catch (e) {
      // 处理函数没写 header 时才好发错误响应
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal', message: errMessage(e) })
      } else {
        res.end()
      }
    }
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!
    const a = actual[i]!
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a)
    } else if (p !== a) {
      return null
    }
  }
  return params
}

const MAX_BODY_BYTES = 8 * 1024 * 1024 // 贴图可能不小

async function readBody(req: IncomingMessage): Promise<unknown> {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined

  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
