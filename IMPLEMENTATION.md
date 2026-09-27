# QB 初版实现方案（v1）

> 配套文档：`AGENTS.md`（产品方案，本文件是它的实现层）。
> 本文件描述**怎么落地**：仓库结构、数据模型、接口、执行语义、里程碑、验收。

---

## 0. 实证结论（决定架构的事实）

在 `@deepseek-ai/dsh@0.1.5-rc.3`（240 个包全量安装）上读真实 `.d.ts` 与组合配置验证，非文档推断：

| # | 承重假设 | 结论 | 证据 |
|---|---|---|---|
| A | 第三方能挂自己的 SPA 和 HTTP 路由 | **成立** | `ctx.webServer.register({kind:'prefix'\|'exact', path, handler})`、`registerUpgrade`（WebSocket）、`tapIndex` 均为公开 API。包头注释：*"It knows no harness concepts and serves no files; the composing application owns dist serving."* 匹配顺序 exact → 最长 prefix → fallback，内置 UI 占 fallback，故 `/qb/*` 与其共存 |
| B | 自定义 RPC | **改道** | typert `@Remote` 需 build-time codegen，且只认 HttpOnly cookie（`GET /?token=` 铸造），第三方不顺。**放弃 typert，直接用 A 的裸路由做 REST + WS** |
| C | 外部插件可挂载 | **成立** | `dsh --patch <path>`（可重复）挂任意外部 YAML overlay，开发期无需发 npm 包；发布期用 bundle（`package.json` 的 `dsh.bundle.patch`）+ `dsh plugin --profile qb add <pkg>` |
| D | 带超时地跑命令并流式取输出，不经模型 | **成立** | `ctx.shell.resolve(req) → spec`、`run(spec) → ShellRunResult{exitCode,signal,timedOut,stdout,stderr}`、`start(spec) → ShellProcess{status, done, readOutput(), kill()}`。`ShellExecRequest` 含 `timeoutMs / signal / env / workdir / stdin`；源码注释明确 stdin·env 是给 *in-process plugins* 用的（hooks bridges 即如此），非模型工具参数 |

**生态增量**（选 dsh 的实际理由）：自带 `dsh-skill`（skill 注册表 seam）、`dsh-goal`、`dsh-workflow`、`dsh-terminal`（持久 PTY）、`dsh-schedule`（cron/间隔，恢复原会话投递）、`dsh-subagent`、`dsh-mcp-client`、`dsh-llm-pi-ai`（通用 OpenAI/Anthropic 兼容适配）、`dsh-user-questions`、`dsh-jobs-local`。Web UI 自身由约 20 个 `dsh-client-ui-*` 插件组合而成——第三方扩 UI 是设计内的用法。

**v2 追加（2026-09-27）**：
- dsh `ctx.llm` 没有 toolChoice，强制不了结构化输出。
- DeepSeek 默认开 thinking，此时强制工具调用返回 400。
- 因此模型调用改走 Vercel AI SDK v7，删掉手写的 SSE 解析。证据与决策见 `docs/adr/0002-llm-via-ai-sdk.md`。

**已知风险与对策**：
- npm 子包版本落后 monorepo；peer 版本不匹配的 bundle 会被**静默跳过**（`skippedBundles`）→ 锁定 `0.1.5-rc.3`，启动时主动断言 QB 插件已加载，未加载就报错而非静默降级。
- 官方 `AGENTS.md` 声明 *"Public APIs are pre-stable"*，无弃用政策 → 所有 dsh 调用收敛到 `packages/engine/src/dsh/` 一层适配（`HostPort` 接口），换 harness 只改这层。
- dsh 禁止第三方包自带 bin（*"package bins … are forbidden"*）→ QB 的 `qb` 命令是我们自己的启动器，内部 spawn `dsh --profile qb`，不注册进 dsh。

---

## 1. 架构

```
┌─ 用户浏览器 ──────────────────────────────────────────────┐
│  http://127.0.0.1:3080/qb   ← QB SPA（React）              │
│  http://127.0.0.1:3080/     ← dsh 内置 UI（保留，自由对话） │
└───────────────┬───────────────────────────────────────────┘
                │ REST /qb/api/*  +  WS /qb/ws
┌───────────────┴─── dsh 进程（profile: qb）────────────────┐
│  dsh 内核：llm · shell · terminal · jobs · schedule ·      │
│            skill · session · mcp · agent loop             │
│  ┌─ @qb/engine（我们的插件）──────────────────────────┐   │
│  │  web-mount   webServer.register('/qb', SPA+API)    │   │
│  │  runner      ctx.shell.run/start → 步骤执行与流式   │   │
│  │  agent       QB 的 6 种行为（起草/陪跑/求助/复盘…） │   │
│  │  sync        ←→ team server（离线队列 + 脱敏）      │   │
│  └────────────────────────────────────────────────────┘   │
└───────────────┬───────────────────────────────────────────┘
                │ HTTP（单人时 in-process，多人时内网）
┌───────────────┴─── @qb/server（团队层）───────────────────┐
│  Hono + SQLite(Drizzle+FTS5)：任务/Runbook/事件的真源     │
│  Skill · 坑 · 环境 · 用户 · 通知 · 检索                    │
└───────────────────────────────────────────────────────────┘
```

**数据流向**：SPA 只跟本机 engine 说话（同源，无 CORS）；engine 负责执行、捕获证据、本地缓存与离线队列；team server 是跨人数据的真源。看别人的 runbook 也经 engine 取只读镜像。

**为什么 SPA 挂在 dsh 端口而不是独立端口**：同源，免 CORS 与二次鉴权；用户只启一个进程；dsh 内置 UI 在 `/` 依然可用（QB 面板的"自由对话"直接跳过去）。

---

## 2. 仓库结构

```
qb/
├── package.json              # pnpm workspace root, packageManager: pnpm@11.24.0
├── pnpm-workspace.yaml
├── tsconfig.base.json        # strict, moduleResolution: bundler
├── AGENTS.md                 # 产品方案
├── IMPLEMENTATION.md         # 本文件
├── docs/adr/
│   └── 0001-dsh-api-surface.md   # 依赖的 dsh API 清单 + 版本锁 + 逃生路线
├── packages/
│   ├── core/       @qb/core     零依赖：zod schema + 纯函数
│   ├── server/     @qb/server   Hono + Drizzle(SQLite) 团队层
│   ├── engine/     @qb/engine   dsh 插件（bundle）
│   ├── ui/         @qb/ui       React SPA，构建产物由 engine 托管
│   └── cli/        @qb/cli      `qb` 启动器
└── profiles/qb/
    ├── package.json          # dsh.profile.bundles
    └── cordis.patch.yml      # 叠加 @qb/engine 到 web profile
```

**依赖版本**（均为当前 latest，已核）：
`hono@4.13` · `drizzle-orm@0.45` · `better-sqlite3@13` · `zod@4.6` · `react@19.3` · `vite@8.3` · `tailwindcss@4.3` · `@tanstack/react-query@5.104` · `@dnd-kit/core@6.3` · `@codemirror/view@6.43` · `nanoid@6` · `tsx@4.23` · `vitest@5`
运行时：Node `^22.19 || >=24`（dsh 要求）；本机 v26.4 ✓。TypeScript 用 `5.9`（7.0 太新，生态未跟上）。

---

## 3. 数据模型（`@qb/core`，SQLite 存储）

所有 id 用 `nanoid`；所有时间戳 `INTEGER`（epoch ms）；软删除用 `archived_at`。

```
users(id, name, display_name, created_at)

tasks(id, title, brief_md, initiator_id, assignee_id,
      parent_step_id,            -- 非空 = 由委派产生，递归结构就靠它
      status,                    -- draft|active|blocked|done|abandoned
      expected_minutes, due_at, definition_of_done,
      created_at, started_at, ended_at)

runbooks(id, task_id, version, created_by, created_at,
         assumptions_json,       -- 顶部"假设"列表，可编辑
         source_skill_id, source_skill_version)
         -- 每次 QB 重规划或人编辑产生新 version；v1 全量存储（体积无忧）

steps(id, runbook_id, parent_id, order_key,   -- order_key: 分数索引，拖拽重排不重写兄弟节点
      kind,                      -- command|check|wait|manual|delegate|decision|note
      title, why_md, why_source, -- why_source: 'skill:xxx§3' 之类的出处
      command, env_id, expectation_json, timeout_ms, expected_minutes,
      status,                    -- pending|running|ok|failed|skipped|blocked
      started_at, ended_at, actual_ms,
      delegate_task_id)          -- kind=delegate 时指向子任务

evidence(id, step_id, source,    -- auto|paste|image
         text, image_path, exit_code, timed_out, duration_ms, created_at,
         redacted)               -- 脱敏是否生效

events(id, task_id, step_id, actor_id, kind, payload_json, created_at)
      -- kind: step_run|step_ok|step_failed|step_timeout|edit|reorder|insert|
      --       situation_changed|question_asked|question_answered|
      --       delegate_progress|lesson_proposed|lesson_confirmed|replanned

skills(id, name, description, applies_when, owner_id, current_version)
skill_versions(id, skill_id, version, template_json, created_at, created_by,
               source_runbook_id, stats_json)   -- stats: 次数/成功率/每步耗时中位数

lessons(id, anchor_kind, anchor_ref,   -- skill_step|environment|free
        condition, symptom, cause, fix_md, next_time_md,
        author_id, source_task_id, scope,   -- personal|team
        confirmed_by, confirmed_at, hit_count, miss_count, stale_at, created_at)

environments(id, name, facts_json, collected_at, owner_id)
      -- facts: os/shell/gpu/cuda/paths/proxy/quirks

questions(id, task_id, step_id, asker_id, target_id,
          body_md, options_json, answer_md, answered_by, answered_at, lesson_id)
```

**检索**：`lessons`、`skills`、`events` 建 FTS5 虚表；`@qb/server` 的 `search.ts` 统一出口，后续换 embeddings 只改这一个文件。

**v2 变更**（迁移 v2 起，全部增量，不破坏现有数据）：

```
steps      + rev                     -- 乐观并发；每次编辑 +1
           + lineage_key             -- 步骤血缘：复制底稿时保留；坑挂在这上面（存量步骤迁移时补上）
           + origin                  -- human|import|base|qb
           + source_ref              -- 素材 id + 片段（出处）
           + deleted_at              -- 软删除（撤销用）
           + status_note             -- 跳过/失败的原因
runbooks   assumptions_json → params_json   -- [{name,value,description,source,secret}]；旧假设迁成 source='qb_guess'
           + base_runbook_id, origin -- import|adapt|draft|copy
runbook_snapshots(id, runbook_id, reason, steps_json, params_json, created_by, created_at)  -- 大改前的快照
materials(id, task_id, kind, text, filename, created_by, created_at)                      -- 贴进来的原文
tasks_fts                            -- 标题 + 描述，用于找底稿
evidence.image_path                  -- 真正启用：图片存数据目录，按哈希命名
lessons    + condition_json, fix_steps_json, status；anchor_kind 新增 step_lineage
model_profiles(本机)                 -- key 只存本机
outbox(本机)                         -- M8 发件箱
```

runbook 改为**原地修改**：编辑是 `edit` 事件（改前/改后），不再每次保存都新建版本；QB 的大改以 diff 原地应用，应用前写快照。

**`order_key` 用分数索引**（LexoRank 简化版）：拖拽只改被移动节点一行，避免重排整棵树。

---

## 4. `@qb/core`：纯逻辑（无 IO，100% 可单测）

```
schema/         zod 定义 + 类型导出（所有包的单一事实源）
expectation.ts  预期检查：exitCode | contains | regex | jsonPath | manual
                → { verdict: 'pass'|'fail'|'unclear', reason }
                unclear 才唤醒模型判断（省 token，且确定性优先）
runbook.ts      树操作：insert/move/split/skip、order_key 生成、版本 diff
danger.ts       破坏性命令模式：rm -rf, mkfs, dd, :>, --force, DROP,
                kubectl delete, shutdown, reboot, chmod -R 777 …
                → { level: 'safe'|'caution'|'destructive', matched }
redact.ts       脱敏：sk-*, ghp_*, AKIA*, password=, token=, Bearer,
                PEM 块, ssh 私钥；可加团队自定义规则
escalate.ts     卡住判定：相对 expected_minutes 超时 / 连续失败 N 次 /
                等待回答超过 M 分钟 → 该不该上浮给发起人
```

---

## 5. `@qb/engine`：dsh 插件

```ts
// packages/engine/src/index.ts
export const name = 'qb-engine'
export const inject = ['webServer', 'shell', 'llm', 'jobs', 'schedule']

export function apply(ctx: Context, config: Config) {
  const host = createHostPort(ctx)        // ← 唯一接触 dsh 的地方
  const api  = createApi(host, config)

  ctx.webServer.register({ kind: 'prefix', path: '/qb/api', handler: api.rest })
  ctx.webServer.registerUpgrade({ path: '/qb/ws', handler: api.ws })
  ctx.webServer.register({ kind: 'prefix', path: '/qb', handler: serveSpa() })

  registerQbTools(ctx)                    // 模型可调的 QB 工具
  ctx.systemPrompt.section('qb', () => buildQbPrompt(...))
}
```

**`HostPort` 适配层**（换 harness 只改这里）：

```ts
interface HostPort {
  runCommand(req: {command, cwd?, env?, timeoutMs, signal?}): Promise<RunResult>
  startCommand(req): { onChunk(cb), done: Promise<RunResult>, kill() }
  complete(req: {messages, tools?, schema?}): Promise<Completion>
  schedule(at, fn): Disposable
}
```
对 dsh 的实现：`runCommand → ctx.shell.run(ctx.shell.resolve(req))`；`startCommand → ctx.shell.start(...)` 轮询 `readOutput()` 推 WS；`complete → ctx.llm`；`schedule → ctx.schedule`。

**REST**（全部挂 `/qb/api`）：
```
GET  /tasks                  POST /tasks
GET  /tasks/:id              PATCH /tasks/:id
GET  /tasks/:id/runbook      POST /tasks/:id/replan
POST /steps/:id/run          POST /steps/:id/cancel
POST /steps/:id/evidence     PATCH /steps/:id
POST /steps/:id/move         POST /steps/:id/split
POST /tasks/:id/situation    POST /tasks/:id/question
POST /tasks/:id/retrospect
GET  /skills  /lessons  /environments  /inbox
```

**WS**（`/qb/ws`）：服务端推 `step.output`（流式）/ `step.status` / `task.event` / `qb.message`；客户端只发心跳与订阅。

**步骤执行时序**（`POST /steps/:id/run`）：
1. `danger.ts` 判级；`destructive` 且未带 `confirmed:true` → 400 要求前端亮红框（不弹窗）
2. 写 `events(step_run)`，状态 → `running`
3. `kind=command`：`host.runCommand`，`timeout_ms` 默认取 skill 统计的 p95×2，兜底 120s
   `kind=wait`：`host.startCommand` + 就绪探针（http/port/log-pattern/command）轮询，进 `ctx.jobs` 后台，QB 面板说"我盯着"
4. 输出经 `redact.ts` 后存 `evidence`，同时流式推 WS
5. `expectation.ts` 判定；`pass/fail` 直接落库，`unclear` 才调模型
6. 失败 → 检索 `lessons`（按 anchor + 症状 FTS）→ 有命中则 QB 面板给"一键应用修法"

---

## 6. QB Agent（6 种行为）

提示词是 `packages/engine/prompts/*.md`，与代码同版本管理。所有结构化输出走**工具调用的 JSON schema**，不解析自由文本。

| 行为 | 触发 | 产出工具 |
|---|---|---|
| draft | 新任务 | `qb_runbook_propose(tree, assumptions[])` |
| accompany | 步骤结束/超时 | `qb_step_evaluate(verdict, reason)` · `qb_runbook_patch(ops[])` |
| ask | 点"问发起人"或连续失败 | `qb_question_draft(body_md, options[], suggested_target)` |
| retrospect | 任务完成 | `qb_lesson_propose[]` · `qb_skill_diff_propose` · 耗时校准 |
| observe | 旁观模式 | 订阅 dsh `session/event` 的 `command/run`·`tool/result` → `qb_runbook_patch` |
| oversee | 定时/事件 | 卡住检测 + 发起人摘要 |

**模型接入**（v2 修订，ADR 0002）：
- 模型调用只经 `packages/engine/src/llm/`（Vercel AI SDK v7），统一用 `streamText + Output.object(zod)`。
- `partialOutputStream` 推给 UI；schema 是给模型的严格契约，校验时宽容（`.catch`，坏项丢弃）；结构性失败重试一次。
- 结构化调用默认关 thinking，并且必须显式给 `maxOutputTokens`。
- 端点由"模型档案"决定（设置页 + 测试连接 + 能力档案），环境变量可覆盖。公司内网 vLLM 走 OpenAI 兼容 + `json_schema`。

**v2 新增的行为**：
- `import`：忠实结构化 + 参数提取 + 坑 + 缺口，之后跑确定性保真/覆盖校验。
- `adapt`：以底稿为基础，把这次的说明变成差异。
- `ask`：代拟求助。
- 空白起草 `draft` 降为兜底。

**起草提示词要点**（决定第一印象）：模糊之处**不追问**，写成顶部可编辑的"假设"；每步必须有可验证的预期和预计耗时；"为什么"一句话并注明出处；命令按目标环境事实渲染。

---

## 7. `@qb/ui`：Runbook 活文档

```
src/
  runbook/   RunbookPage · Outline（左，dnd-kit）· StepCell（中）· QbPanel（右）
  step/      CommandBlock（CodeMirror 只读 + 运行/复制）· OutputBlock（流式 + 折叠）
             EvidencePaste（文本/图片粘贴）· ExpectationRow · LessonChips
  task/      TaskList（灵魂宝石状态）· NewTask · Inbox
  skill/     SkillLibrary · SkillDiff
  lib/       api.ts（fetch 封装）· ws.ts（重连）· store.ts（zustand）
```

技术选择：Vite + React 19 + Tailwind 4；React Query 管服务端状态；zustand 管本地 UI 态；dnd-kit 拖拽；CodeMirror 6 显示命令与输出（等宽、可选中、大输出虚拟滚动）。构建产物 `packages/ui/dist` 由 engine 的 `serveSpa()` 托管。

**v1 必须做到的交互**（对应产品宪法）：
- 当前步自动高亮与滚动；`j/k` 上下步；专注模式（隐藏两侧栏）
- 内联编辑所有字段（点即编辑，blur 保存，无"编辑模式"）
- 拖拽重排 + 单元间 `+` 插入
- `[▶运行]` 流式输出；`[⧉复制]` 一键复制；输出区可直接 Ctrl+V 贴文本或图片
- 破坏性命令红框 + 内联"确认运行"开关（不弹窗）
- 无任何"标记为完成"的强制表单——自动观察优先

---

## 8. 里程碑

### 8.0 实际进度与 v2 里程碑（2026-09-27）

**已完成（见 git 历史）**

| 里程碑 | 内容 |
|---|---|
| M1 | core 纯逻辑 + engine 的 dsh 插件地基 |
| M2 | 数据真源 + 端到端执行闭环（运行、超时、取消、预期判定、证据落库） |
| M3 | Runbook 活文档界面（大纲、单元、QB 面板、专注模式） |
| M4 | 模型起草 runbook、环境感知、证据持久化 |
| M5 | GLM-5.3 真实起草、流式、异步任务、失败诊断 |
| M6 | 可编辑活文档（原地修改+撤销+rev 并发）、AI SDK 模型层、截图证据（存取+看图判定）、模型设置（测试连接/能力档案/热切换）、本机请求守卫；双审查修复一轮 |
| M7 | 从已有的开始：贴素材忠实导入（保真/覆盖/出处/缺口）、底稿复制+差异（情况变了同机制）、参数（面板/渲染/同值联动/提取参数化/缺值挡运行）、终端分流 L0.5、评测集（pnpm eval：导入 11/11 逐字·差异 11 项参数全对） |
| M8 | 实时同步给 PL：@qb/team 团队服务（邀请登录/镜像同步/幂等续传）、@qb/store 改名、escalate 确定性告警（连续失败/停滞/失控/求助）、信件栈+IM 推送（webhook+Python 脚本）、远程 UI（免安装，只看不执行）、问发起人转正（回答回流到步骤）、评论、任务可指定发起人；e2e 18/18（含 webhook 实收与断网续传）。审查修复：静态资源以正确 MIME 托管（原先白屏）、管理员角色（渠道/邀请限管理员，命令渠道=shell）、邀请原子消费+续发 API、同步重入锁+下行事务游标+评论按 id 去重、webhook 响应体不回显（SSRF）、onError 固定文案、WS 心跳、ack/回答守卫、建任务记 task_created 事件、拍子 2s |
| M9 | 坑的闭环：七捕获时机（失败后修好/记个坑按钮/偏离底稿/情况变了/求助回答沉淀/导入原文坑锚血缘/复盘清单）、三层显示（条件匹配一行预警→折叠计数→失败全浮出，@qb/core conditions 确定性匹配）、[按这个修]（插修复步骤跑通自动记帮上）、血缘共享（引擎上传→团队按血缘路由给同血缘执行者，按状态全量重发不丢老坑）、发起人确认/驳回（🟡 lesson_pending，结果回流打戳/降 personal）、两次"不是这个"+零帮上→疑似过期、底稿提议（带回底稿→同血缘执行者应用/冲突不盲改）；e2e 19/19（双引擎双用户真跑）+ 浏览器 14/14 |

**待做（按顺序）**。设计见 AGENTS.md §12；每个里程碑完成后跑两路审查，并把场景写进 `测试手册.md`。

**M6 · 可编辑的活文档 + 换模型层**

要做的：
- 在 dsh 进程里加载 AI SDK 的冒烟测试。
- `packages/engine/src/llm/` 替换 `provider.ts`：宽容 schema + 重试；起草时步骤流式出现。
- 默认改用 DeepSeek；密钥不再写进 `.run/patch.yml`。
- 编辑全套：内联编辑、插入、删除（可撤销）、重排、进出章节、跳过/失败带原因、来源标记、`edit` 事件与 `rev`、大改先留快照。
- 截图证据：粘贴或拖入 → 存盘 → 可见 → 可交给看图模型。
- 模型设置页：预设、测试连接、能力档案、热切换。
- 空按钮："问发起人"改成临时的复制到 IM（界面上标注）；"情况变了"在 M7 前先隐藏。

验收：
- 改命令后复制得到新命令，刷新后仍在；时间线有改前改后，撤销能恢复。
- 贴图后刷新仍可见。
- DeepSeek 测试连接全绿；切到 GLM 不用重启。
- 起草的首步在 5 秒内出现。

**M7 · 从已有的开始 + 参数**

要做的：
- 新任务单输入框 + 底稿推荐；导入 / 调整 / 终端日志 / 空白四条路。
- 保真、覆盖、出处校验；模型列出的缺口变成问题。
- 参数面板：就地改值、同值联动、提取建议、缺参数、secret。
- "情况变了"复用差异机制；"与上次不同"高亮。
- L0.5：一次贴一大段终端输出，自动分到各步。
- 导入出的坑按第二层折叠显示。
- 评测集第一版。

验收：
- 贴 PD wiki，15 秒内出完整 runbook，命令全部逐字或被标注。
- 改一个参数后所有命令同步，并提示同值参数。
- 贴 PL 的一段话，得到正确的差异和要问的问题。
- 贴一段跨三步的终端输出，三步各自取证并判定。

**M8 · 实时同步给 PL**

要做的：
- `@qb/team`（Hono + SQLite + `ws`）：邀请链接登录；发件箱同步、离线续传；脱敏。
- 远程模式 UI；派任务、委派行。
- 告警规则、信件栈、IM webhook、免打扰、日报。
- 问发起人、评论、建议修改。
- `@qb/server` 改名为 `@qb/store`。

验收：
- PL 用第二个浏览器能实时看到进度。
- 同一步失败 3 次后 PL 收到 🔴，webhook 也收到。
- 评论 2 秒内到达执行者。
- 断网期间的事件在重连后补齐。

**M9 · 坑的闭环（已完成）**

落点：
- `@qb/core/conditions.ts`：结构化条件（`DECODE_HOST == gpu-18 AND 环境.GPU 包含 H800`）的解析与匹配，纯确定性。
- 捕获（`agent/capture.ts` + `lesson_offers` 表）：①失败→改命令→跑通 ②每步 [记个坑] ③偏离底稿→带回 ④情况变了的原因 ⑤求助回答到达 ⑥导入原文的坑锚步骤血缘 ⑦复盘清单。
- 三层显示（`api-m9` GET /tasks/:id/lessons + StepCell）：匹配的坑一行预警，其余折叠计数，失败时全部浮出带 [按这个修]/[不是这个]；"只看主线"开关；大纲 ⚠。
- 共享：记坑可选"并共享"（脱敏上传）；团队按血缘路由给同血缘的其他执行者（按状态全量重发——新任务用旧血缘不丢老坑）；发起人确认/驳回（🟡 告警 + 远程 UI 按钮），结果回流（确认打戳 / 驳回降回 personal）。
- 命中统计：[按这个修] 插入的修复步骤跑通 → 自动帮上一次；两次"不是这个"且零帮上 → 疑似过期（退出第一层、不再进起草检索）。
- 底稿提议：执行者把偏离发给所有同血缘持有者，应用时命令仍是 before 才改（否则标冲突），先裁定者生效。

验收（e2e-m9 19/19，双引擎双用户）：
- 失败 → 修好后弹出预填好的"记成坑？"（症状=失败输出尾部、修法=diff）。
- 同血缘的另一个用户在那一步看到第一层预警（带作者与未验证标注）。
- 两次"不是这个"后标为疑似过期并退出第一层。

**M10 · 终端接入**

- L1 会话日志跟随（`@xterm/headless`）、OSC 133、执行报告导出、ssh 目标。
- L2 桥接脚本（实验）。

**到时要问的**（不阻塞现在）：
- M8 之前：公司用哪个 IM？团队服务放在哪台机器？
- M10 之前：能直连 GPU 机器，还是只能走堡垒机？用 SecureCRT 还是 Xshell，什么版本？

### 8.1 v1 原始里程碑（已被 8.0 取代，保留作对照）

**M1 — 骨架可跑（可见的第一屏）**
workspace 脚手架 · `@qb/core` schema 与纯函数 + 单测 · `@qb/server` 建表与 CRUD · `@qb/engine` 挂 `/qb` 路由 · `@qb/ui` 渲染一个硬编码 runbook · `qb` 启动器。
**验收**：`pnpm qb` 打开浏览器看到 Runbook 页面；`/qb/api/health` 返回版本；dsh 内置 UI 在 `/` 仍正常。

**M2 — 执行闭环（核心价值）**
`[▶运行]` 走 `ctx.shell` 流式回显 · 超时与取消 · `expectation` 判定 · 粘贴文本/图片 · `wait` 步骤就绪探针 · 事件时间线 · 内联编辑与拖拽重排。
**验收**：手写一个 5 步 runbook，三种取证方式（自动/粘贴/截图）都正确归档；`sleep 30` + `timeout 800ms` 正确标记 `timedOut` 并可取消。

**M3 — QB 接管（agent 化）**
接 llm seam · draft 起草 runbook · accompany 判定与重规划 diff · "情况变了"入口 · 失败时检索坑并提议修法 · QB 面板叙述。
**验收**：输入"在测试集群跑通 vLLM PD 分离"→ 得到 ≥8 步带命令/预期/耗时的 runbook + 顶部假设列表；故意用错端口 → QB 提议修法 → 一键应用重跑通过。

**M4 — 沉淀闭环（差异化）**
retrospect 复盘 · lesson 提议与一键确认 · skill 结晶与版本 diff · 第二个相似任务复用 skill 与坑 · 旁观模式。
**验收**：完成任务 → 提议 ≥1 个坑 + skill「PD 分离部署」→ 确认；新建相似任务 → 起草直接基于该 skill 且相关步骤显示已沉淀的坑。

**M5 — 两个人（你 + 你的 PL）**
登录（个人令牌）· 派任务给别人 · `delegate` 步骤与委派行 · 只读打开对方 runbook · 求助 + 收件箱 + IM webhook · 发起人摘要与卡住检测 · server 托管远程模式 UI。

M1–M4 是单人 dogfood 的完整闭环，用你真实的 vLLM PD 分离部署喂养。

---

## 9. 工程约定

- **测试**：`@qb/core` 的纯函数必须有单测（expectation / danger / redact / order_key / runbook diff）；engine 与 server 用 vitest 做集成测试（真起 `ctx.shell`、真建 SQLite 临时库）；UI 先不做 e2e。
- **类型**：`strict: true`，禁止 `any`；跨包只经 `@qb/core` 的导出类型。
- **dsh 边界**：除 `packages/engine/src/dsh/` 外，任何文件不得 import `@deepseek-ai/*`。ADR 记录用到的每个 API，越界先补 ADR。
- **模型边界**：除 `packages/engine/src/llm/` 外，任何文件不得 import `ai` / `@ai-sdk/*`；不手写任何模型协议解析（ADR 0002）。
- **密钥**：不进仓库、日志、终端回显，也不进任何生成的配置文件。
- **版本锁**：`@deepseek-ai/dsh` 锁 `0.1.5-rc.3`（不用 `^`）；启动时断言 QB 插件已加载，未加载直接报错。
- **提示词**：`packages/engine/prompts/*.md` 带版本号；每次模型调用记录提示词版本与模型 id 到 `events`；M4 后建金标准 runbook 回归集。
- **中文**：界面、提示词与代码注释用中文（与现有代码一致），代码标识符用英文。

---

## 10. 立即开始的顺序

1. workspace 骨架 + `tsconfig.base.json` + ADR 0001
2. `@qb/core` schema（数据模型的单一事实源，其他包都依赖它）
3. `@qb/server` 建表 + 最小 CRUD
4. `@qb/engine` 挂路由（此处做第一次**运行时**实证：真起 dsh，确认 `/qb` 可达、`ctx.shell` 可用）
5. `@qb/ui` 渲染硬编码 runbook → 通电
6. 打通 `[▶运行]` → M2 闭环
