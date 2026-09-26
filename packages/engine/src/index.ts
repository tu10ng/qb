import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, Store } from '@qb/server'
import { createDshHostPort, type DshContext } from './dsh/host-port.ts'
import { collectEnvironment } from './agent/environment.ts'
import type { ProviderConfig } from './dsh/provider.ts'
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
  /**
   * 模型端点。不配的话 QB 的起草等能力会明确报错而不是静默失效。
   * wire=openai 可直接指向公司内网的 vLLM。
   */
  llm?: ProviderConfig
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx: DshContext, config: Config): void {
  const mount = config.mountPath ?? '/qb'
  const host = createDshHostPort(ctx, config.llm)
  const ws = createWsHandler()

  const store = new Store(openDb({ path: config.dbPath }))
  // 单人阶段不做注册流程：本地用户直接就是当前用户。
  const me = store.ensureUser(config.userName ?? 'me')

  // 提示词是 QB 的核心资产，与代码同版本管理
  const prompts = {
    persona: readPrompt('qb-persona.md'),
    draft: readPrompt('draft.md'),
    diagnose: readPrompt('diagnose.md'),
  }

  const api = buildApi({ host, store, ws, mount, currentUserId: () => me.id, prompts })

  ctx.webServer.register({ kind: 'prefix', path: `${mount}/api`, handler: api.handle })
  ctx.webServer.registerUpgrade({ path: `${mount}/ws`, handler: ws.handler })
  ctx.webServer.register({
    kind: 'prefix',
    path: mount,
    handler: createSpaHandler(config.distDir, mount),
  })

  // 这条日志是"插件真的加载了"的唯一凭证：dsh 会静默跳过
  // peer 版本不匹配的 bundle，启动自检据此判断。
  const llmNote = config.llm === undefined ? '未配置模型' : `模型 ${config.llm.model}`
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
