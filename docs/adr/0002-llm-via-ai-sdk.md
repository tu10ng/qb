# ADR 0002 — 模型调用走 Vercel AI SDK v7，不走 dsh `ctx.llm`，不手写协议解析

- 状态：已接受
- 日期：2026-09-27
- 修订：ADR 0001 中"模型 → `ctx.llm`"一行作废；`inject` 不含 `llm`；`HostPort.complete` 移除

## 背景

QB 的每种模型行为（导入、调整、起草、诊断、代拟求助）都要求**结构化输出**：一份 runbook、一组参数、一份差异。结构化输出有两个硬需求：

1. 能强制模型按 schema 输出（强制工具调用、原生 structured output 或 JSON 模式）。
2. 能流式拿到部分对象，让步骤边生成边出现。实测首步 2–5s，全程 10–24s。

M4/M5 为此在 `packages/engine/src/dsh/provider.ts` 里手写了 SSE 解析和工具调用组装。这违背了"用天生兼容 OpenAI/Anthropic 端点的库、避免手动解析"的原则，而且接入 DeepSeek 时直接失败（见下）。

## 实测证据（2026-09-26/27，本机）

| 事实 | 证据 |
|---|---|
| dsh `ctx.llm` 强制不了结构化输出 | `@deepseek-ai/dsh-llm@0.1.5-rc.3` 的 `GenerateOptions` 没有 `toolChoice` |
| DeepSeek 默认开 thinking，此时强制工具调用返回 400 | `deepseek-flash`、`deepseek-v4-pro`：`"Thinking mode does not support this tool_choice"`。现有 `provider.ts` 发的是强制 tool_choice 且不带 thinking 参数，必挂 |
| 关 thinking 后又快又稳 | 非流式：flash 13.3s，v4-pro 19.5s。开 thinking + auto：flash 61s，v4-pro 205s |
| AI SDK v7 流式结构化可用 | `streamText` + `Output.object(zod)`：首个完整步骤 2.4–4.7s；DeepSeek 原生端点（JSON 模式）严格 schema 下 4/4 通过 |
| 部分 Claude 模型也拒绝强制工具 | AI SDK 的 `getModelCapabilities` 已内置此类差异，如 Opus 5.5、Fable 5.1 会自动改用原生 outputFormat。不用自己维护 |
| 陷阱：默认输出上限 | 非 Claude 模型走 Anthropic 兼容端点时，SDK 默认 `max_tokens = 4096`，必须显式给 `maxOutputTokens` |
| 严格 schema 在兼容端点上会失败 | Anthropic 兼容路径和 GLM 反复报"不符合 schema"：v4-pro 只输出第一个字段就停；flash 编出枚举外的 kind；GLM 漏必填字段 |
| 宽容 schema 修好了 | 给模型看的仍是严格契约（enum、required 保留，zod `toJSONSchema` 输出只多一个 `default`），校验时 `.catch()` 兜底、坏项置 null 丢弃：DeepSeek flash/pro 8/8 通过 |
| 忠实导入可行 | 一份含 13 行命令的 PD 部署 wiki：flash 9.6–12.1s，两次 13/13 逐字、一次 15/16（唯一改写被确定性校验标出），原文命令 0 遗漏 |
| 看图可行 | flash 两条路径都在约 1.1s 内读出截图里的 `No route to host` 与 IP。v7 用 `file` part，`image` part 已废弃 |

实验脚本：`.spike/bench-deepseek.mjs`、`.spike/sdk/{spike,lenient,raw-blocks}.mjs`，素材在 `.spike/sdk/fixtures/`（`.spike` 已 gitignore）。

## 决策

### 1. 库

- `ai@^7` + `@ai-sdk/anthropic@^4` + `@ai-sdk/openai-compatible@^3` + `@ai-sdk/deepseek@^3`，zod 4。
- 覆盖的端点：Anthropic 兼容（DeepSeek、GLM、Claude）、OpenAI 兼容（OpenAI、公司内网 vLLM）、DeepSeek 原生。

### 2. 调用形状（只有这一种）

```ts
streamText({
  model,                       // 由模型档案创建
  system, prompt | messages,   // 图片用 { type: 'file', data, mediaType }
  output: Output.object({ schema }),
  providerOptions,             // 由档案决定，例如 DeepSeek-Anthropic：{ anthropic: { structuredOutputMode: 'jsonTool', thinking: { type: 'disabled' } } }
  maxOutputTokens,             // 必须显式给
  abortSignal,
})
// partialOutputStream → 经 WS 推给 UI（步骤流式出现）
// output → 最终结果，已按 schema 校验
```

### 3. schema 一份两用

- zod schema 同时是给模型的契约和校验器。删掉手写的 JSON schema 副本（`DRAFT_SCHEMA`）。
- 非关键字段用 `.catch(默认值)`；数组项用 `Item.nullable().catch(null)`，事后过滤 null。一步坏了不废掉整份。
- 结构性失败（缺顶层字段、`NoObjectGeneratedError`）自动重试一次；仍失败时把模型原文附在错误里，便于诊断。

### 4. thinking

- 结构化调用默认关。
- 可以慢一点的调用（诊断）在能力档案允许时可开。DeepSeek 原生端点的 JSON 模式可以和 thinking 同开，实测 low effort 31s。

### 5. 模型档案与能力测试

- 档案字段：wire、baseURL、model、key（只存本机）、用途、选项。
- "测试连接"依次测：连通、鉴权、强制结构化（含 thinking 冲突）、流式部分对象、看图、延迟，结果写入能力档案。
- 环境变量（`QB_LLM_*`）可以覆盖档案。key 不写进任何生成的配置文件（如 `.run/patch.yml`），也不写日志。

### 6. 边界

- 模型调用只经 `packages/engine/src/llm/`。
- 其余代码只认一个 `Llm` 端口（便于测试替身），不 import `ai` / `@ai-sdk/*`。
- `HostPort` 只保留执行与定时。

## 考虑过的替代

| 方案 | 否决理由 |
|---|---|
| dsh `ctx.llm`（dsh-llm-pi-ai） | 没有 toolChoice，强制不了结构化；按 ADR 0001 它本是首选，但缺这一项就用不了 |
| 直接用 pi-ai | 统一 toolChoice 只有 `auto`/`none`，强制工具要走各 API 的私有选项；没有 zod 原生的结构化输出，也没有部分对象流 |
| 官方 `@anthropic-ai/sdk` + `openai` 两套 | 两套调用形状，要自己统一结构化输出、部分解析和模型差异 |
| 继续手写 | 违背原则；DeepSeek 已证明它会在协议细节上坏掉 |

## 后果

- **正面**：
  - 不再手写协议解析。
  - 结构化输出、部分对象流、图片、各家模型的特殊行为都由业界标准库维护。
  - 换模型只改档案。
- **负面**：
  - 新增 4 个依赖。
  - dsh 内置聊天与 QB 各有一份模型配置（以后可由 QB 档案生成 dsh 的配置）。
- **待验证**：在 dsh 进程里加载 `ai` 包（M6 第一步做冒烟测试）。
