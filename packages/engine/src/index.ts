import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, Store } from '@qb/store'
import { createDshHostPort, type DshContext } from './dsh/host-port.ts'
import { collectEnvironment } from './agent/environment.ts'
import { createLlm } from './llm/index.ts'
import { LlmSettings } from './settings/llm-settings.ts'
import { buildApi } from './web/api.ts'
import { Attachments } from './web/attachments.ts'
import { createLocalGuard } from './web/local-guard.ts'
import { createWsHandler } from './web/ws.ts'
import { createSync, TeamSettings } from './sync/sync.ts'
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

const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx: DshContext, config: Config): void {
  const mount = config.mountPath ?? '/qb'
  const host = createDshHostPort(ctx)
  // 本机引擎能执行命令：只接受来自本机页面的请求（见 local-guard.ts）
  const guard = createLocalGuard(() => [ctx.webServer.host])
  const ws = createWsHandler({ guard: (req) => guard.upgrade(req) })

  const store = new Store(openDb({ path: config.dbPath }))
  // 单人阶段不做注册流程：本地用户直接就是当前用户。
  const me = store.ensureUser(config.userName ?? 'me')

  // 模型档案：本机保存的 + 环境变量（.env.local）里的。key 不经过 dsh 的配置文件。
  const settings = new LlmSettings(store, process.env)
  const llm = createLlm(settings)

  // 截图与数据库放在一起；内存库（冒烟测试）用临时目录
  const attachments = new Attachments(
    config.dbPath === ':memory:' ? join(tmpdir(), 'qb-attachments') : join(dirname(config.dbPath), 'attachments'),
  )

  // 提示词是 QB 的核心资产，与代码同版本管理
  const prompts = {
    persona: readPrompt('qb-persona.md'),
    draft: readPrompt('draft.md'),
    diagnose: readPrompt('diagnose.md'),
    import: readPrompt('import.md'),
    adapt: readPrompt('adapt.md'),
  }

  // M8：团队同步（见下方 interval 注释）。
  const team = new TeamSettings(store)
  const sync = createSync({
    store,
    userName: () => config.userName ?? 'me',
    broadcast: (data) => ws.broadcast(data),
    log: (msg) => console.warn(`[qb] ${msg}`),
  })
  // 2 秒一拍：方案验收要求"PL 的评论 2 秒内到达执行者"。
  // 无上行时是 pull-only（很轻），这个频率没有负担。
  ctx.setInterval(() => sync.pushNow(), 2000)

  const api = buildApi({
    host,
    store,
    ws,
    mount,
    currentUserId: () => me.id,
    prompts,
    llm,
    settings,
    attachments,
    guard,
    team: { settings: team, sync },
  })

  ctx.webServer.register({ kind: 'prefix', path: `${mount}/api`, handler: api.handle })
  ctx.webServer.registerUpgrade({ path: `${mount}/ws`, handler: ws.handler })
  ctx.webServer.register({
    kind: 'prefix',
    path: mount,
    handler: createSpaHandler(config.distDir, mount),
  })

  // 这条日志是"插件真的加载了"的唯一凭证：dsh 会静默跳过
  // peer 版本不匹配的 bundle，启动自检据此判断。
  const status = llm.status('structure')
  const llmNote = status.ok ? `模型 ${status.profileName}` : '未配置模型'
  console.log(`[qb] 已挂载 http://${ctx.webServer.host}:${ctx.webServer.port}${mount}（${llmNote}）`)

  // 后台采集本机环境事实，供起草时渲染命令用。失败不影响启动。
  void collectEnvironment(host)
    .then((facts) => {
      store.upsertEnvironment({ name: 'local', facts, ownerId: me.id })
      console.log(`[qb] 环境已采集：${facts.os ?? '未知系统'}${facts.gpu !== undefined ? `，${facts.gpu}` : ''}`)
    })
    .catch((e: unknown) => {
      console.warn('[qb] 环境采集失败（不影响使用）:', e instanceof Error ? e.message : e)
    })
}

function readPrompt(name: string): string {
  return readFileSync(join(HERE, '..', 'prompts', name), 'utf8')
}
