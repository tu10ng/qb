# ADR 0001 — 依赖 dsh 的 API 面与边界

- 状态：已接受
- 日期：2026-09-26
- 锁定版本：`@deepseek-ai/dsh@0.1.5-rc.3`（精确锁，不用 `^`）

## 背景

QB 的执行层需要：本地 GUI、能调本地工具、带超时地执行命令并流式取输出、模型接入、事件日志、定时。这些 dsh 已经具备，且它的插件生态（skill / goal / workflow / terminal / schedule / subagent / mcp-client）与 QB 的领域高度重合。

但 dsh 处于 developer preview，其根 `AGENTS.md` 明确声明 *"Public APIs are pre-stable; update every consumer."*，且无弃用政策；npm 子包版本落后 monorepo。因此需要一条明确的边界，使 dsh 的破坏性变更只影响一个目录。

## 决策

### 1. 只依赖下列 API（经安装后读真实 `.d.ts` 验证）

| 能力 | API | 用途 |
|---|---|---|
| HTTP 路由 | `ctx.webServer.register({ kind: 'exact' \| 'prefix', path, handler })` → 返回 disposer | 挂 `/qb`（SPA）与 `/qb/api`（REST） |
| WebSocket | `ctx.webServer.registerUpgrade({ path, handler })` | 挂 `/qb/ws`（步骤输出流式推送） |
| 端口信息 | `ctx.webServer.port` / `.host` | 启动器打印 URL |
| 命令执行 | `ctx.shell.resolve(req) → spec`；`ctx.shell.run(spec) → ShellRunResult` | `command` / `check` 步骤 |
| 长任务 | `ctx.shell.start(spec) → ShellProcess { status, done, readOutput(), kill() }` | `wait` 步骤（起服务、下模型） |
| 模型 | `ctx.llm`（经 `dsh-llm-pi-ai`，OpenAI/Anthropic 兼容） | QB 的 6 种 agent 行为 |
| 后台任务 | `ctx.jobs` | `wait` 步骤的就绪轮询 |
| 定时 | `ctx.schedule` | 回访、卡住检测、摘要 |
| 会话事件 | `session/event` 订阅 | 旁观模式读 `command/run`、`tool/result` |
| 工具注册 | `ctx.tools.register(defineTool(...))` | 让模型能调 QB 的工具 |
| 提示词 | `ctx.systemPrompt.section(...)` | 注入 QB 人格与当前任务上下文 |

关键类型（来自 `@deepseek-ai/dsh-shell`）：

```ts
interface ShellExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string                       // 源码注释：给 in-process plugins 用，非模型工具参数
  env?: Record<string, string>
}
interface ShellRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  timeoutMs: number
  stdout: string
  stderr: string
}
interface ShellProcess {
  status: 'running' | 'completed' | 'killed'
  readonly done: Promise<void>         // 永不 reject
  readOutput(): ShellProcessRead       // 消费式增量读
  kill(): boolean
}
```

### 2. 明确不依赖

- **typert `@Remote` RPC**：需 build-time codegen，且只接受 `GET /?token=` 铸造的 HttpOnly cookie，第三方不可用。QB 改用 `webServer.register` 裸 REST + `registerUpgrade` 裸 WS。
- **`registerFallback`**：已被内置 UI 的 SPA server 占用（第二次注册抛错）。QB 用 `prefix` 路由，与内置 UI 共存。
- **dsh 的 `ctx.skills`**：语义是"给模型的提示词片段"，与 QB 的"可执行步骤模板 + 坑 + 统计"不同。v1 不依赖；后续可把 QB skill 库注册为一个 provider（加分项）。
- **包自带 bin**：dsh 的 `AGENTS.md` 禁止（*"package bins, demos, and public SDK argv escapes are forbidden"*）。`qb` 命令是我们自己的启动器，内部 spawn `dsh --profile qb`。

### 3. 隔离方式

- 除 `packages/engine/src/dsh/` 外，任何文件不得 `import '@deepseek-ai/*'`。
- 该目录导出 `HostPort` 接口，上层只认这个接口：

```ts
interface HostPort {
  runCommand(req: RunRequest): Promise<RunResult>
  startCommand(req: RunRequest): StreamingRun
  complete(req: CompletionRequest): Promise<Completion>
  schedule(at: Date | number, fn: () => void): Disposable
}
```

- 换 harness（Claude Agent SDK / 自研 loop）只需另写一个 `HostPort` 实现。

### 4. 防静默降级

peer 版本不匹配的 bundle 会被 dsh **静默跳过**（记入 `skippedBundles`）。因此 `@qb/cli` 启动后必须探测 `/qb/api/health`；探测失败即报错退出，不允许"界面打不开但进程活着"的状态。

## 开发期挂载

`dsh --patch <path>` 可重复，接受任意外部 YAML overlay，开发期无需发布 npm 包：

```yaml
- insert:
    - id: qb-engine
      name: '@qb/engine'
      inject: [webServer, shell, llm, jobs, schedule]
```

发布期改为 bundle（`package.json` 的 `dsh.bundle.patch`）+ `dsh plugin --profile qb add @qb/engine`。

## 后果

- 正面：复用 dsh 的本地 GUI 宿主、shell seam、模型适配、事件日志与整个插件生态，QB 只写领域逻辑。
- 负面：绑定一个 pre-stable 的运行时；升级 dsh 需回归测试 `packages/engine/src/dsh/`。
- 缓解：精确版本锁 + 单一适配目录 + 启动自检。
