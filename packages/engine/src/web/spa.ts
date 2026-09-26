import { readFile } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * 托管 SPA 构建产物。
 *
 * 挂在 /qb 前缀下，与 dsh 内置 UI（占着 fallback 位）共存。
 * 未命中的路径回落到 index.html，交给前端路由。
 */
export function createSpaHandler(distDir: string, mountPath: string) {
  const root = resolve(distDir)

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rel = url.pathname.startsWith(mountPath)
      ? url.pathname.slice(mountPath.length)
      : url.pathname

    const file = await readSafe(root, rel)
    if (file !== null) {
      res.writeHead(200, {
        'content-type': MIME[extname(file.path)] ?? 'application/octet-stream',
        'content-length': file.data.length,
        // 带 hash 的资源可以长缓存；index.html 不缓存，否则改版后用户看到旧壳
        'cache-control': file.path.endsWith('index.html')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      })
      res.end(file.data)
      return
    }

    // SPA 回落
    const index = await readSafe(root, '/index.html')
    if (index === null) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`QB 前端尚未构建：${root} 下没有 index.html\n先运行 pnpm --filter @qb/ui build`)
      return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(index.data)
  }
}

interface ReadResult {
  path: string
  data: Buffer
}

/** 读文件，并确保不会越出 root（防路径穿越）。 */
async function readSafe(root: string, rel: string): Promise<ReadResult | null> {
  if (rel === '' || rel === '/') rel = '/index.html'

  const decoded = decodeURIComponent(rel)
  const target = resolve(join(root, normalize(decoded)))

  // resolve 之后再比对前缀，`..` 已被规范化掉
  if (target !== root && !target.startsWith(root + sep)) return null

  try {
    const data = await readFile(target)
    return { path: target, data }
  } catch {
    return null
  }
}

function extname(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i)
}
