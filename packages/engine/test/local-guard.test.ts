import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createLocalGuard } from '../src/web/local-guard.ts'

function req(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}

const guard = createLocalGuard(() => ['qb.local'])

describe('本机引擎的请求守卫', () => {
  it('本机页面的请求放行', () => {
    expect(guard.http(req('GET', { host: '127.0.0.1:3080' }))).toBeNull()
    expect(guard.http(req('POST', { host: 'localhost:3080', origin: 'http://localhost:3080', 'content-type': 'application/json' }))).toBeNull()
    expect(guard.http(req('GET', { host: '[::1]:3080' }))).toBeNull()
    // 配置里另外允许的监听地址
    expect(guard.http(req('GET', { host: 'qb.local:3080' }))).toBeNull()
  })

  it('本机脚本不带 Origin，放行', () => {
    expect(guard.http(req('POST', { host: '127.0.0.1:3099', 'content-type': 'application/json' }))).toBeNull()
  })

  it('DNS rebinding：Host 不是本机地址时拒绝', () => {
    expect(guard.http(req('GET', { host: 'evil.example.com:3080' }))).toMatch(/Host/)
    expect(guard.http(req('GET', {}))).toMatch(/Host/)
  })

  it('跨站网页发来的请求拒绝', () => {
    expect(
      guard.http(req('POST', { host: '127.0.0.1:3080', origin: 'https://evil.example.com', 'content-type': 'application/json' })),
    ).toMatch(/跨站/)
    expect(guard.http(req('POST', { host: '127.0.0.1:3080', origin: 'null', 'content-type': 'application/json' }))).toMatch(/来源/)
  })

  it('写操作必须是 application/json：挡住不触发预检的"简单请求"', () => {
    expect(guard.http(req('POST', { host: '127.0.0.1:3080', 'content-type': 'text/plain' }))).toMatch(/application\/json/)
    expect(guard.http(req('DELETE', { host: '127.0.0.1:3080' }))).toMatch(/application\/json/)
    expect(guard.http(req('POST', { host: '127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' }))).toBeNull()
  })

  it('WebSocket：跨站网页不能连上来读广播', () => {
    expect(guard.upgrade(req('GET', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBeNull()
    expect(guard.upgrade(req('GET', { host: '127.0.0.1:3080', origin: 'https://evil.example.com' }))).toMatch(/跨站/)
    expect(guard.upgrade(req('GET', { host: 'evil.example.com' }))).toMatch(/Host/)
  })
})
