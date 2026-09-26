import { describe, expect, it } from 'vitest'
import { Router, sendJson } from '../src/web/router.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 造一个最小的 req/res 对，够路由器用。 */
function fakeReqRes(method: string, url: string, body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  } as unknown as IncomingMessage

  const captured = { status: 0, body: '', headers: {} as Record<string, unknown> }
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers
      this.headersSent = true
      return this
    },
    end(data?: string) {
      if (data !== undefined) captured.body = data
    },
  } as unknown as ServerResponse

  return { req, res, captured }
}

describe('Router', () => {
  it('匹配静态路径', async () => {
    const r = new Router('/qb/api')
    r.get('/health', (_q, res) => sendJson(res, 200, { ok: true }))

    const { req, res, captured } = fakeReqRes('GET', '/qb/api/health')
    await r.handle(req, res)

    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ ok: true })
  })

  it('提取路径参数', async () => {
    const r = new Router('/qb/api')
    r.post('/steps/:id/run', (_q, res, ctx) => sendJson(res, 200, { id: ctx.params.id }))

    const { req, res, captured } = fakeReqRes('POST', '/qb/api/steps/stp_abc/run', {})
    await r.handle(req, res)

    expect(JSON.parse(captured.body)).toEqual({ id: 'stp_abc' })
  })

  it('解析 JSON body', async () => {
    const r = new Router('/qb/api')
    r.post('/echo', (_q, res, ctx) => sendJson(res, 200, ctx.body))

    const { req, res, captured } = fakeReqRes('POST', '/qb/api/echo', { hello: 'world' })
    await r.handle(req, res)

    expect(JSON.parse(captured.body)).toEqual({ hello: 'world' })
  })

  it('解析 query', async () => {
    const r = new Router('/qb/api')
    r.get('/tasks', (_q, res, ctx) => sendJson(res, 200, { status: ctx.query.get('status') }))

    const { req, res, captured } = fakeReqRes('GET', '/qb/api/tasks?status=active')
    await r.handle(req, res)

    expect(JSON.parse(captured.body)).toEqual({ status: 'active' })
  })

  it('未匹配返回 404', async () => {
    const r = new Router('/qb/api')
    r.get('/health', (_q, res) => sendJson(res, 200, {}))

    const { req, res, captured } = fakeReqRes('GET', '/qb/api/nope')
    await r.handle(req, res)

    expect(captured.status).toBe(404)
  })

  it('方法不匹配也返回 404', async () => {
    const r = new Router('/qb/api')
    r.get('/health', (_q, res) => sendJson(res, 200, {}))

    const { req, res, captured } = fakeReqRes('POST', '/qb/api/health', {})
    await r.handle(req, res)

    expect(captured.status).toBe(404)
  })

  it('处理函数抛错时返回 500 而不是崩溃', async () => {
    const r = new Router('/qb/api')
    r.get('/boom', () => {
      throw new Error('炸了')
    })

    const { req, res, captured } = fakeReqRes('GET', '/qb/api/boom')
    await r.handle(req, res)

    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body).message).toBe('炸了')
  })

  it('非法 JSON body 报错而不是静默当成空', async () => {
    const r = new Router('/qb/api')
    r.post('/echo', (_q, res, ctx) => sendJson(res, 200, ctx.body))

    const req = {
      method: 'POST',
      url: '/qb/api/echo',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{not json')
      },
    } as unknown as IncomingMessage

    const captured = { status: 0, body: '' }
    const res = {
      headersSent: false,
      writeHead(s: number) {
        captured.status = s
        this.headersSent = true
        return this
      },
      end(d?: string) {
        if (d !== undefined) captured.body = d
      },
    } as unknown as ServerResponse

    await r.handle(req, res)
    expect(captured.status).toBe(500)
    expect(captured.body).toContain('JSON')
  })
})
