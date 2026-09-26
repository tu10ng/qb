/**
 * 开发启动器：起 dsh + QB 插件，打印访问地址。
 *
 * 用法：pnpm dev
 * 停止：Ctrl-C
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, writeFile, access } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const runDir = join(repoRoot, '.run')
const distDir = join(repoRoot, 'packages/ui/dist')

const PORT = Number(process.env.QB_PORT ?? 3080)
const MOUNT = '/qb'

const posix = (p) => p.replaceAll('\\', '/')
const fileUrl = (p) => {
  const n = posix(p)
  return n.startsWith('/') ? `file://${n}` : `file:///${n}`
}

async function main() {
  await mkdir(runDir, { recursive: true })

  try {
    await access(join(distDir, 'index.html'))
  } catch {
    console.error('前端尚未构建。先运行：pnpm --filter @qb/ui build')
    process.exit(1)
  }

  const patch = join(runDir, 'patch.yml')
  await writeFile(
    patch,
    [
      '- insert:',
      '    - id: qb-engine',
      `      name: '${fileUrl(join(repoRoot, 'packages/engine/src/index.ts'))}'`,
      '      inject: [webServer, shell, timer]',
      '      config:',
      `        distDir: '${posix(distDir)}'`,
      `        dbPath: '${posix(join(runDir, 'qb.db'))}'`,
      `        mountPath: '${MOUNT}'`,
      `        userName: '${process.env.QB_USER ?? 'me'}'`,
      '',
    ].join('\n'),
    'utf8',
  )

  const child = spawn(
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
    {
      env: { ...process.env, DSH_HOME: join(runDir, 'dsh-home') },
      stdio: 'inherit',
    },
  )

  const stop = () => child.kill()
  process.on('SIGINT', stop)
  process.on('exit', stop)

  child.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
