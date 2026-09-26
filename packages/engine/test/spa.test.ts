import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSpaHandler } from '../src/web/spa.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

let dist: string
let secretDir: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'qb-spa-'))
  dist = join(base, 'dist')
  secretDir = base
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<html>QB</html>')
  await writeFile(join(dist, 'assets', 'app-a1b2.js'), 'console.log(1)')
  // 放在 dist 之外，用来验证不会被读到
  await writeFile(join(base, 'secret.txt'), 'TOP SECRET')
})

afterAll(async () => {
  await rm(secretDir, { recursive: true, force: true })
})

function call(handler: ReturnType<typeof createSpaHandler>, url: string) {
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      this.headersSent = true
      return this
    },
    end(data?: Buffer | string) {
      if (data !== undefined) captured.body = data.toString()
    },
  } as unknown as ServerResponse

  return handler(req, res).then(() => captured)
}

describe('createSpaHandler', () => {
  it('根路径返回 index.html', async () => {
    const h = createSpaHandler(dist, '/qb')
    const r = await call(h, '/qb')
    expect(r.status).toBe(200)
    expect(r.body).toContain('QB')
    expect(r.headers['content-type']).toContain('text/html')
  })

  it('返回静态资源并带正确 MIME', async () => {
    const h = createSpaHandler(dist, '/qb')
    const r = await call(h, '/qb/assets/app-a1b2.js')
    expect(r.status).toBe(200)
    expect(r.body).toBe('console.log(1)')
    expect(r.headers['content-type']).toContain('javascript')
  })

  it('带 hash 的资源长缓存，index.html 不缓存', async () => {
    const h = createSpaHandler(dist, '/qb')
    const asset = await call(h, '/qb/assets/app-a1b2.js')
    const index = await call(h, '/qb/')
    expect(asset.headers['cache-control']).toContain('immutable')
    expect(index.headers['cache-control']).toBe('no-cache')
  })

  it('未知路径回落到 index.html（前端路由）', async () => {
    const h = createSpaHandler(dist, '/qb')
    const r = await call(h, '/qb/tasks/tsk_abc')
    expect(r.status).toBe(200)
    expect(r.body).toContain('QB')
  })

  describe('路径穿越防护', () => {
    const attacks = [
      '/qb/../secret.txt',
      '/qb/../../secret.txt',
      '/qb/assets/../../secret.txt',
      '/qb/%2e%2e/secret.txt',
      '/qb/%2e%2e%2fsecret.txt',
      '/qb/....//secret.txt',
    ]

    for (const attack of attacks) {
      it(attack, async () => {
        const h = createSpaHandler(dist, '/qb')
        const r = await call(h, attack)
        // 要么回落到 index（未读到文件），要么拒绝——绝不能返回秘密内容
        expect(r.body).not.toContain('TOP SECRET')
      })
    }
  })

  it('dist 不存在时给出可操作的提示', async () => {
    const h = createSpaHandler(join(secretDir, 'nonexistent'), '/qb')
    const r = await call(h, '/qb')
    expect(r.status).toBe(500)
    expect(r.body).toContain('pnpm --filter @qb/ui build')
  })
})
