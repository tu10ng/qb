import { openDb, Store } from '@qb/server'
import { createDshHostPort, type DshContext } from './dsh/host-port.ts'
import { buildApi } from './web/api.ts'
import { createWsHandler } from './web/ws.ts'
import { createSpaHandler } from './web/spa.ts'

export const name = 'qb-engine'
// timer 是 cordis 的定时器服务：ctx.setInterval / setTimeout 都来自它，
// 不声明就取不到（cordis 的 inject 是强制的）。
export const inject = ['webServer', 'shell', 'timer']

export interface Config {
  /** SPA 构建产物目录。 */
  distDir: string
  /** SQLite 文件路径；':memory:' 用于冒烟测试。 */
  dbPath: string
  /** 挂载前缀，默认 /qb。 */
  mountPath?: string
  /** 单人 dogfood 阶段的用户名；多人阶段换成令牌鉴权。 */
  userName?: string
}

export function apply(ctx: DshContext, config: Config): void {
  const mount = config.mountPath ?? '/qb'
  const host = createDshHostPort(ctx)
  const ws = createWsHandler()

  const store = new Store(openDb({ path: config.dbPath }))
  // 单人阶段不做注册流程：本地用户直接就是当前用户。
  const me = store.ensureUser(config.userName ?? 'me')

  const api = buildApi({ host, store, ws, mount, currentUserId: () => me.id })

  ctx.webServer.register({ kind: 'prefix', path: `${mount}/api`, handler: api.handle })
  ctx.webServer.registerUpgrade({ path: `${mount}/ws`, handler: ws.handler })
  ctx.webServer.register({
    kind: 'prefix',
    path: mount,
    handler: createSpaHandler(config.distDir, mount),
  })

  // 这条日志是"插件真的加载了"的唯一凭证：dsh 会静默跳过
  // peer 版本不匹配的 bundle，启动自检据此判断。
  console.log(`[qb] 已挂载 http://${ctx.webServer.host}:${ctx.webServer.port}${mount}`)
}
