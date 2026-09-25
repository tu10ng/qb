# QB 方案：把人当 agent 来运行的任务 harness

> 这是"方案"，不是排期。按你的要求：只描述终极目标、终极长相、交互体验和支撑它们的架构；实现由 agent 完成，难度不作为取舍依据，只用阶段划分保证你能尽早 dogfood。
>
> 四轮对齐已确认：① 人即 agent，QB 是运行人的 harness；② 每个人同一个 UI、递归委派、没有"PL 端"；③ 相信用户不当保姆（运行/复制/贴文本/贴图随意，不弹多余确认）；④ 任务页 = Runbook 活文档；⑤ 执行层基于 DeepSeek Harness（dsh），团队层自建，TypeScript。

---

## 1. Context：为什么做

- PL 派给新人的活，大多是**有历史的重复活**，只是随时间、周边领域、服务器环境有细微差别。这些差别没人有时间记录，新人天天踩同样的坑；新人沉默寡言，PL 只好反复巡视、同步、教基础操作。PL 的时间被"巡视"吃掉。
- 《缺氧》的类比：没有自动化之前，玩家被迫不停点开每个小人；建成自动化之后才能把注意力放到提升整个基地。现实里的 PL 正处在"没有自动化"的阶段。
- 现有任务管理 / 甘特 / GTD 工具是"人类天生方案"：把组织工作的负担全放在人身上（建任务、排优先级、更新状态、写文档），工具只是被动数据库。
- 你自己刚到新部门当新人，正在啃 vLLM / PD 分离部署的坑，需要一个东西顺手把走过的流程、下过的命令、遇到的问题沉淀下来，并让新 PL 高效地和你同步。

**目标结果**：新人跟着 runbook 就能入门一个领域、不重复踩坑；老员工的经验不用写文档就被沉淀成 skill；发起任务的人只在真正需要判断时被打扰；每一次执行都让下一次更准。

---

## 2. 核心模型：人即 agent，QB 是运行人的 harness

Claude Code / dsh 运行的是模型 agent；QB 运行的是**人这个 agent**。逐项对应：

| agent harness（dsh 运行模型） | QB（运行人） |
|---|---|
| 用户给的 prompt | **任务**：发起人写的一段描述（就像给 agent 写 prompt） |
| tools | **Tools**：执行者可用的东西——MCP、脚本、机器/集群、权限、文档 |
| skills（过程性知识文件） | **Skills**：团队做某类事的套路（步骤模板 + 变量 + 坑） |
| system prompt | QB 自动组装：团队规范 + 环境事实 + 执行者画像，人不写 |
| agent 的 plan / todo | **Runbook**：一份树形、可执行、可编辑的活文档 |
| tool call + result | **步骤执行 + 输出**（QB 跑的自动捕获；人跑的贴文本/贴图） |
| 调 subagent | **委派**：我 runbook 里的一步变成别人的任务，对方的 runbook 就是这一步的展开 |
| session log | **任务时间线**：所有事件（执行、编辑、重排、意外、求助、回答） |
| memory / 学习 | **Skill 演化 + 坑**：从 runbook 的"计划 vs 实际"里自动结晶 |
| ask user | **问发起人 / 求助**：QB 代拟、带上下文、一句话可答 |
| permission prompt | **没有**。相信用户；只对明显破坏性命令做视觉警示 |

**递归**：发起人上面还有发起人。"PL" 只是"给我发了这个任务的人"这个相对角色。所以整个系统只有一种用户、一种任务页、一种 runbook；层级是任务之间的委派关系自然形成的，不需要组织架构配置。

---

## 3. 设计宪法（任何功能先过这十一条）

1. **零组织负担**：人不建任务结构、不排优先级、不更新状态。人只做三件事：写目标、执行、反应。
2. **跟着走就行，但一切细节可见**：runbook 像教程；每步的"为什么 / 命令 / 预期 / 坑 / 出处"都在原地，不藏在弹窗里。
3. **相信用户，不当保姆**：运行按钮、复制按钮、手动跑、贴文本、贴截图、直接点完成——随用户喜好；没有多余确认；只对匹配破坏性模式的命令（`rm -rf`、`--force`、`drop`、`kubectl delete` 等）加红色边框与内联的"确认运行"开关。
4. **自动观察优先，手动补充随时**：QB 跑的自动记录输出、耗时、成败；人跑的贴回来即可；不填表。
5. **预期是显式的，偏差由 QB 发现**：每步带"应该在多久内看到什么"。超时、输出不符、耗时异常由 QB 主动说话，不靠人盯。
6. **随时可改、可重排、可报告意外**：runbook 是活文档：内联编辑、拖拽重排、插入、拆细、跳过。"情况变了"一键报告 → QB 重规划受影响的步骤（给 diff）→ 事件上浮到发起人。
7. **沟通被代理但不被垄断**：QB 代拟求助 / 汇报，带完整上下文；用户可改可直发；发起人一句话回；答案立即生效并沉淀。
8. **零文档义务**：skill 和坑由 runbook 结晶，人只做一键确认或改一行。
9. **流程不能停**：等待时 QB 继续做能做的事（"这步我盯着，你先看下一步"）；求助超时给最安全的默认路径；任何步骤都有"跳过并记录"的出口。
10. **信任渐进**：重复跑顺的 skill 步骤可以整段自动执行，人只看结果——这就是《缺氧》的"自动化时刻"。
11. **统一且递归**：每个人同一个 UI；委派 = 我 runbook 里的一步；对方的 runbook = 这一步的展开；事件自动上浮。

---

## 4. 对象（用户视角）

| 对象 | 是什么 | 关键字段 |
|---|---|---|
| **任务** Task | 一份"契约"：发起人 → 执行者 | 描述（markdown prompt）、发起人（可为自己）、执行者、附带 skills、附带 tools/环境、期望（截止、预计时长、完成定义）、父步骤（若由委派产生）、状态、健康度 |
| **Runbook** | 任务的活文档，一棵树 | 章节 → 步骤；当前位置；版本历史（每次 QB 重规划或人编辑都留版本） |
| **步骤** Step | 执行者面对的最小单元 | 类型（见下）、标题、为什么（一句话 + skill 出处）、命令/动作、目标环境、预期、超时、预计耗时、实际耗时、状态、证据（输出/粘贴/截图）、相关坑 |
| **Skill** | 团队做某类事的套路 | 适用条件、步骤模板（带变量）、每步的坑、版本、来源 runbook、统计（次数、成功率、每步耗时中位数）、负责人 |
| **Tool** | 执行者可用的东西 | 类型（MCP server / 脚本 / 机器或集群 / 权限指引 / 文档 / 网页系统）、配置、可用范围 |
| **环境** Environment | 机器/集群的事实 | OS、shell、GPU、CUDA、路径、代理、怪癖；QB 自动采集 + 人补几项；命令按环境渲染 |
| **坑** Lesson | 条件 → 症状 → 原因 → 修法 → 下次计划该怎么改 | 锚点（skill 的某步 / 环境 / 自由）、出处（谁、哪次任务、何时）、层级（个人 / 团队已确认 / 疑似过期）、有效性统计 |
| **事件** Event | 时间线上的一切 | 执行/失败/超时、编辑/重排/插入、"情况变了"、求助/回答、委派进度、坑提议/确认、QB 重规划 |
| **求助** Question | 执行者 → 发起人（或某位专家） | QB 代拟的正文 + 选项、答复、是否沉淀为坑 |

步骤类型：

| 类型 | 含义 | 执行方式 | 预期检查 |
|---|---|---|---|
| `command` | 一条命令 | [▶运行]（本机 dsh 执行，用执行者自己的 ssh/凭据）或 [⧉复制] 手动 | 退出码 / 输出匹配 / 模糊时由 QB 判断 |
| `check` | 验证某事 | 命令或人工 | 同上 |
| `wait` | 长任务、起服务、等外部审批 | QB 启动后轮询（HTTP / 端口 / 日志模式 / 命令），带间隔和超时，"我盯着" | 就绪条件 |
| `manual` | 只有人能做（找人、点网页、做判断） | 人做完点完成，可贴截图 | 可选 |
| `delegate` | 委派给别人 | 生成对方的任务；本行显示对方进度 | 对方任务完成 |
| `decision` | 需要发起人/专家拍板 | 变成一条求助 | 得到答复 |
| `note` | 说明、链接、图片 | — | — |

---

## 5. 终极长相：Runbook 活文档

### 5.1 布局（已选定）

```
任务: X集群 PD分离部署   来自: 老王   ◐顺利  1h10m/预计3h
─────────────┬──────────────────────────────┬─────────────
大纲          │ Runbook (可编辑 / 拖拽重排)    │ QB
✓ 1 准备      │                              │
▶ 2 启动      │ ## 2 启动                     │ 2.2 已启动,
  ✓ 2.1       │ ▶ 2.2 拉起 decode (预计8分钟)  │ 我盯着健康
  ▶ 2.2       │   为什么: … (skill「PD分离」§3) │ 检查, 你先
    2.3       │   $ vllm serve … --kv-transfer │ 看 2.3 吧。
    2.4       │   [▶运行] [⧉复制]              │
  3 验证      │   预期: /health 200, 日志出现…  │ ⚠ 坑: NCCL
  4 交接      │   输出: 自动捕获 | 粘贴文本/截图 │ 版本不一致
              │   ▌INFO Started server 2m13s ✓ │ 会卡初始化
              │ ○ 2.3 启动 prefill …   [编辑]  │ (小B, 上月)
              │ ○ 2.4 起 proxy                │
              │                              │ [情况变了…]
              │                              │ [问老王]
```

- **左：大纲树**。章节/步骤、状态符号、可拖拽重排、点击跳转；当前步自动高亮。
- **中：文档**。每步一个"单元"，Jupyter/Notion 式；当前步高亮并自动滚动；所有字段内联可编辑；单元间的 `+` 或 `/` 插入新步骤；拖拽手柄重排；右键/菜单：拆细、委派给…、跳过、标记失败。
- **右：QB 面板**。QB 的叙述（"我盯着"、发现偏差、建议修法）、当前步的相关坑、快捷动作（情况变了… / 问发起人 / 让 QB 重新规划 / 旁观模式），底部是自由对话输入（就是 dsh 的聊天，随时可以直接和 QB 说话）。
- **专注模式**开关：隐藏左右栏，只放大当前步，`j/k` 上下步。这就是"树形教程 + 单步卡片"那个形态，作为模式而非主界面。

### 5.2 步骤单元的解剖

```
▶ 2.2  拉起 decode 实例                      预计 8 分钟 · 在 gpu-17
       为什么: decode 侧先起，prefill 才能注册 KV 通道 — skill「PD分离」§3
       ┌ $ vllm serve $MODEL --port 8100 --kv-transfer-config '…'   [▶运行] [⧉复制] ┐
       └ 环境: gpu-17 (bash · CUDA 12.4 · 8×H800)                                 ┘
       预期: 8 分钟内 http://gpu-17:8100/health 返回 200；日志出现 "Started server"
       输出: [自动捕获 ▾] [粘贴文本] [粘贴/拖入截图]
             ▌INFO 09:41:12 … Started server process        ✓ 符合预期 · 2m13s
       坑: ⚠ NCCL 版本不一致会卡在初始化（小B，上月，团队已确认）  ⚠ …（小A，未验证）
       [完成] [跳过] [失败…]   [编辑] [委派给…] [拆细]
```

- **[▶运行]**：直接通过本机 dsh 的 shell 执行（不经过模型、不弹确认），输出流式进入单元，超时由 QB 强制执行，预期检查自动跑，状态自动更新。
- **[⧉复制]**：复制命令；用户自己去跑。跑完可以贴文本、贴截图（多模态给 QB 判断），也可以什么都不贴直接点 [完成]。
- 破坏性命令：红色边框 + 内联"确认运行"开关；不弹窗。
- **委派行**（别人在做的一步）：
  ```
  ▶ 3.2 → 委派给小A: X集群 PD分离部署   ◐ 2.2/14  1h10m/预计3h
        最近事件: 小A 重排了 2.3/2.4 · 无阻塞     [打开她的 runbook] [留言]
  ```
  点开就是她的 runbook（只读 + 留言/回答）；她那边的事件（开始、卡住、求助、完成、重排）实时刷新这一行。

### 5.3 其他页面（同一套视觉语言）

| 页面 | 内容 |
|---|---|
| **任务列表**（左侧常驻侧栏） | 我在执行的 / 我派出的；每项一个"灵魂宝石"● 顺利 ◐ 有波折 ○ 卡住需介入；未读事件角标；[新任务] |
| **新任务** | 像给 agent 写 prompt：标题 + 描述（markdown）、给谁（默认自己）、附带 skills（输入描述时 QB 自动推荐）、附带 tools/环境、期望（截止、完成定义）。发送后 QB 起草 runbook；发起人可以先看一眼再发，也可以直接发（执行者那边起草） |
| **收件箱** | 只有例外：需要我回答的求助、卡住的委派、待我确认的坑/skill 更新；每条深链到具体步骤；可配置日报/周报摘要 |
| **Skill 库** | skill 页 = 模板化的 runbook（变量高亮）+ 每步的坑 + 统计 + 版本历史；QB 提议的更新以 diff 形式等待负责人确认 |
| **环境** | 机器/集群事实卡片；QB 自动采集；命令渲染的来源 |
| **成长**（每人） | 跑通过的 skills、独立完成率（未求助的步骤占比）的变化、贡献的坑；只读、自动、不打分排名 |

### 5.4 关键交互流程

1. **发起 → 起草**：发起人写描述、附 skill/tool → QB 检索相似历史任务、skill、坑、目标环境事实 → 起草 runbook；模糊之处**不追问**，写成 runbook 顶部可编辑的"假设：集群 X、模型 Y、版本 Z"；真正无法假设的才出一道选择题。
2. **接收 → 开始**：执行者看到"草稿 · QB 根据 skill「PD分离」和 3 次历史起草"；没有"接受"仪式，第一次运行/编辑就算开始，事件上浮"小A 开始了"。
3. **执行**：见 5.2。长任务由 `wait` 步骤接管："预计 8 分钟，我盯着，你先看 2.3"。
4. **偏差**：超时 / 输出不符 / 失败 → QB 先按症状检索坑 → 有则提议修法（一键应用并重跑）→ 无则给出诊断和 2–3 条可选路径 → 仍不行则一键"问发起人"。
5. **情况变了**：快捷项（被阻塞 / 环境与预期不同 / 这步不需要 / 需要更多时间 / 审批人不在 / 其他）+ 可选一句话 → QB 重规划受影响步骤并给 diff → 执行者接受或改 → 事件上浮。
6. **编辑 / 重排 / 插入 / 拆细**：全部内联；每次改动是一条事件——**人对 QB 计划的修正是最强的学习信号**。
7. **求助**：QB 代拟（目标、步骤、命令、报错尾部、已试过什么、建议选项）→ 执行者改/发 → 发起人收件箱 + IM 卡片（一句话或点选项即可答）→ 答复内联出现在步骤里 → 可一键沉淀为坑。QB 还会建议"上次跑通这个 skill 的是小B"作为备选求助对象。
8. **委派**：选中步骤或章节 → 委派给… → 对方收到一个任务（描述由 QB 从上下文自动起草）→ 我这边变成委派行。
9. **完成 → 复盘**：QB 对比计划 vs 实际（增删改的步骤、耗时偏差、用过的坑、新坑、求助记录）→ 提议：坑 ×n、skill 更新 diff、耗时校准 → 执行者一键确认（对自己立即生效）→ 发起人收到一段摘要，可确认为团队级。
10. **旁观模式**（老员工用）：QB 不驱动，只记录用户在 dsh 里跑的命令和结果，边跑边起草 runbook；结束时问"整理成 skill「升级 vLLM 版本」？"，老员工改两行确认。这是老员工沉淀知识的实际机制：**不是让他们写，是让他们改**。

### 5.5 视觉语言

安静的文档质感（Notion / Linear 一类），命令与输出用等宽字体，一种强调色标记"当前"，状态用符号不用大色块，深浅色主题，中文界面。主题包装保持"轻"：产品名 QB；健康度用"灵魂宝石"亮度，卡住 = 变暗 = 需要发起人"净化"（对应《缺氧》看小人心情的痛点）；其余不强行套隐喻。

---

## 6. QB 在背后做什么（agent 行为与提示词）

QB 是 dsh 里的一个 agent 配置（提示词分节 + 一组工具），六种行为：

| 行为 | 触发 | 输入 | 输出（都通过工具的结构化 schema，不解析文本） |
|---|---|---|---|
| **起草** draft | 新任务 | 任务描述、附带 skills/tools、环境事实、相似历史 runbook、坑 | `qb_runbook_propose`：整棵树 + 假设列表 |
| **陪跑** accompany | 每步开始/结束、运行结果、超时 | 当前步、证据、相关坑 | 叙述；`qb_step_evaluate`（预期判断）；`qb_runbook_patch`（重规划 diff） |
| **代拟求助** ask | 用户点"问发起人"或连续失败 | 全部上下文 | `qb_question_draft`：正文 + 选项 + 建议对象 |
| **复盘** retrospect | 任务完成 | 全部版本 + 事件 + 证据 | `qb_lesson_propose[]`、`qb_skill_diff_propose`、耗时校准、给发起人的摘要 |
| **旁观整理** observe | 旁观模式 | dsh 会话日志（`command/run`、`tool/result`） | 边跑边 `qb_runbook_patch`；结束时 `qb_skill_propose` |
| **发起人摘要** oversee | 定时 / 事件 | 委派任务的事件流 | 卡住检测（相对预期无进展、反复失败、等我回答）、日报 |

**提示词原则**（提示词是核心资产，与代码同等对待）：
- 人格：冷静、简洁、有依据、不过度关心；每步"为什么"一句话；命令精确可复制；预期可验证；引用 skill/坑 的出处。
- 不追问能假设的事；假设写在 runbook 顶部供修改。
- 所有结构化输出只经工具 schema；模型看到的 skill/坑/环境上下文由检索注入，不靠模型回忆。
- 提示词是仓库里的版本化文件；每次模型调用记录提示词版本与模型；用真实任务建立"金标准 runbook"评测集，改提示词跑回归。

---

## 7. 学习闭环（"为什么上次分解得不对，下次怎么分"）

**信号**（按强度）：人对 QB 计划的编辑/重排/插入/删除 > 失败与修法 > "情况变了"报告 > 求助与答复 > 耗时偏差 > 跳过 > 复盘确认。

**沉淀到哪**：优先锚定到 **skill 的某一步**（"这一步在 CUDA 12.4 环境要加 X"），其次锚定环境（"gpu-17 走代理"），最后才是自由坑。

**何时用**：起草时（skill + 坑注入）、每步开始前（坑作为芯片显示在单元里）、失败时（按症状检索）。

**确认层级**：作者个人立即生效 → 发起人 / skill 负责人确认后团队生效；未确认的坑对他人以"小A 上次这么修好的（未验证）"出现而不是隐藏；被使用后无效两次自动标记疑似过期；引用的命令/版本变化时提示复核。

**Skill 演化**：每个完成的 runbook 产出一份 skill diff 提议；负责人接受即新版本；每个版本带统计；每步预计耗时按成功运行的中位数自动校准。所有东西带出处（谁、何时、哪次任务）。

---

## 8. 架构：基于 dsh 的执行层 + 自建团队层

### 8.1 dsh 可行性结论（调研于 2026-09；dsh 于 2026-08-13 开源，MIT，Node/TypeScript，Cordis 微内核，"一切皆插件"，developer preview）

QB 执行层的每项需求都有 dsh 的**公开** API 对应：

| QB 需要 | dsh 提供 | 出处 |
|---|---|---|
| 本地 GUI + 本地工具 | `npx @deepseek-ai/dsh web`（127.0.0.1:3080）、Electron 桌面版；内置 bash / pwsh（`dsh-pwsh-local`，Windows）/ 文件工具 | README、docs/user/guide |
| 模型接入不手写解析 | `dsh-llm-pi-ai`（通用 OpenAI / Anthropic 兼容适配器）、`dsh-llm-deepseek`；自定义 provider 填 base URL / api type / credentials；`ctx.llm.registerAdapter` | docs/user/guide/providers.md、docs/cookbook/adding-an-llm-adapter.md |
| QB 自己的工具 | `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render, presentationMeta }, execute }))` | docs/cookbook/adding-a-tool.md |
| 工具执行管线（超时、计时、破坏性标记） | `tools/pre-execute`（allow/deny/ask）→ `tools/execute`（环绕包装）→ `tools/post-execute` → `tools/result` | docs/event-producer-consumer.md |
| QB 提示词与人格 | `ctx.systemPrompt.section()`（按 agent 作用域覆盖）、`ctx.agentPresets` | docs/architecture.md |
| 给人出选择题 | `ctx.userQuestions` seam + 模型可调的 `ask_user` 工具 | docs/capability-seams.md |
| 长任务、定时 | `ctx.jobs`（后台）、`ctx.schedule`（cron/间隔/一次性，恢复原会话投递） | docs/user/guide/schedule.md |
| 观察实际发生了什么 | append-only `session/event`：`tool/call`、`tool/result`、`command/run`、`approval/*`、`todo/write` 等；会话 JSONL v4 存于 `$DSH_HOME/profiles/<profile>/data/sessions/` | docs/persistence-catalog.md |
| 执行与子进程的可替换 seam | `ctx.shell`（bash-local / bash-sandbox）、`ctx.subprocess`、`ctx.fs` | docs/capability-seams.md |
| UI ↔ 运行时 RPC | Typert Remote：Host 服务上的 `@Remote` 方法，HTTP `/api` + WebSocket `/api/remote.mux`，客户端 `ctx.remote.<ns>.<method>()`，支持流与取消 | docs/api-gateway.md、docs/cookbook/adding-a-remote-api.md |
| 挂载我们的 Web UI | host webserver（`@deepseek-ai/dsh-host-webserver`，`ctx.web` seam；GitHub review 集成示范了额外 WebServer 实例与路由） | docs/user/guide/github-review.md |
| 打包与分发 | bundle = npm 包声明 `dsh.bundle` + `cordis.patch.yml`；profile = `$DSH_HOME/profiles/<name>/`（`package.json` 的 `dsh.profile.bundles` + patch）；`dsh plugin --profile <name> add <pkg>`；自带 profile：`web` / `headless` / `sdk` / `acp` | docs/user/develop/basic/publish.md |
| 开发体验 | `@deepseek-ai/dsh-hmr` 热重载，effect 自动清理 | docs/cordis-tutorial |
| 其他可用 | `@deepseek-ai/dsh-mcp-client`（stdio / streamable HTTP）、subagents（含 Claude Code / Codex provider）、`@deepseek-ai/dsh-plan-mode`、实验中的 `agentTeams` 与 Goals seam、Python SDK | — |

**dsh 明确没有、必须自建**：多用户与登录（单用户单进程，Web UI 无鉴权、默认回环）、集中存储（会话在各自机器）、跨人知识库与检索、发起人视图、IM 通知、成长视图。

**风险与对策**：developer preview、无弃用政策、rc 以周计 → 锁定 dsh 版本；QB 领域、提示词、团队服务放自己的包，对 dsh 只经一层薄适配（工具注册、事件订阅、提示词注入、RPC、web 挂载），适配层定义为接口，未来可换 Claude Agent SDK 或自研 loop。SAFETY.md：无 OS 沙箱 → 破坏性命令视觉警示 + 渐进自动执行只对跑顺的 skill 步骤放开。

### 8.2 拓扑

```
每个人本机：QB（一个命令启动：npx @qb/qb → 包装 dsh --profile qb web）
  ├─ dsh engine（profile "qb"）：模型适配、bash/pwsh/fs、session log、schedule、jobs、subagents、MCP
  ├─ @qb/dsh-qb（我们的 bundle）
  │    tools：qb_task_get · qb_runbook_propose/patch · qb_step_evaluate · qb_lesson_search/propose
  │           qb_skill_search/propose · qb_question_draft · qb_delegate · qb_env_collect
  │    prompt sections：QB 人格与协议 + 当前任务 / 环境 / skill / 坑 的上下文
  │    hooks：session/event → 证据同步与旁观模式；tools/execute → 超时与计时；tools/pre-execute → 破坏性标记（只标不拦）
  │    rpc（@Remote）：qb.runbook.* · qb.step.run/cancel · qb.step.paste · qb.events.subscribe · qb.env.collect
  │    web：把 @qb/ui 挂到 dsh host webserver（同源，无 CORS）；sync：与团队服务的连接、令牌、离线队列、脱敏
  └─ @qb/ui（React SPA：Runbook 活文档、任务列表、新任务、收件箱、Skill 库、环境、成长）

团队服务 @qb/server（内网一台；单人 dogfood 时就在本机自动拉起）
  用户/登录（个人令牌 → OIDC）· Task/Runbook/Event/Question 的真源 · Skill/Tool/Env/Lesson 库
  检索（SQLite FTS5 → embeddings）· 通知（WS + 企业微信/飞书/钉钉 webhook）· 后台复盘与摘要（headless dsh 或直调模型）
  也直接托管 @qb/ui 的"远程模式"（只发任务、答问题、看进度、不执行命令的人无需本地安装）
```

**数据归属**：团队服务是任务 / runbook / skill / 坑 的真源；本机 engine 负责执行、证据捕获、本地缓存与离线队列。UI 只和本机 engine 说话（同源），engine 的 sync 模块和团队服务说话；查看别人的 runbook 也经 engine 从服务端取只读镜像。捕获的输出在同步前做脱敏（令牌/密钥/密码模式，可配置；步骤级"不上传输出"开关）。

**[▶运行] 的路径**：UI → `qb.step.run` → `ctx.shell` 执行（超时、流式输出）→ 记录 `qb/step-run` 会话事件并同步 → 确定性预期检查（退出码 / 匹配）→ 仅在预期模糊或用户贴了文本/截图时唤醒 QB 判断（`agent.inject`）。不经模型、不花 token、不弹确认。

### 8.3 语言与仓库

TypeScript monorepo（pnpm workspaces）。dsh 插件必须是 TS；团队服务同用 TS 以共享类型与工具链（代码由 agent 编写，Rust 不带来收益）。

```
qb/
  package.json · pnpm-workspace.yaml · tsconfig.base.json
  packages/
    core/     @qb/core     zod schema 与类型：Task/Runbook/Step/Skill/Tool/Environment/Lesson/Event/Question；
                           纯逻辑：预期检查、runbook diff、事件上浮规则、破坏性命令模式、脱敏
    server/   @qb/server   Hono + Drizzle(SQLite, FTS5) + WS；令牌登录；REST；IM webhook；后台任务；托管 ui 远程模式
    dsh-qb/   @qb/dsh-qb   dsh bundle：tools/ · prompts/（版本化 .md + evals/）· hooks/ · rpc/ · sync/ · web-mount/
    ui/       @qb/ui       React + Vite；Runbook 编辑器（dnd-kit 拖拽、CodeMirror 命令块、markdown、图片粘贴）
    cli/      @qb/qb       启动器：确保 dsh 与 profile 就绪、按配置拉起本地 server、打开 UI
  profiles/qb/             dsh profile：package.json（dsh.profile.bundles）+ cordis.patch.yml（默认 provider、启用 dsh-qb）
  docs/                    design.md（本方案落库）、ADR、提示词评测说明
```

关键文件（实现时先建）：`packages/core/src/schema/*.ts`（领域 schema，一切的源头）、`packages/dsh-qb/src/tools/runbook.ts`、`packages/dsh-qb/src/rpc/step-run.ts`、`packages/dsh-qb/prompts/draft.md`、`packages/ui/src/runbook/StepCell.tsx`、`packages/server/src/routes/{tasks,runbooks,events,skills,lessons}.ts`、`profiles/qb/cordis.patch.yml`。

**实现前置动作**：锁定一个 dsh 版本（当前 0.1.x rc 系列），通读 docs/cookbook/adding-a-tool.md、docs/capability-seams.md、docs/api-gateway.md、docs/cordis-tutorial/07-into-the-harness.md、docs/user/develop/*，并在 `docs/adr/0001-dsh.md` 记录所依赖的 API 面；任何超出该 API 面的用法都要先补 ADR。

---

## 9. 阶段（按"你能多早 dogfood"排序，不是工期）

**阶段 1 · 单人闭环（你自己用，本机）**
- 本机自动拉起 server（本地用户自动登录）+ dsh profile qb + UI。
- 新任务（给自己）→ QB 起草 runbook（附带 skill 可为空，靠描述与环境）→ Runbook 页全部交互：运行 / 复制 / 贴文本 / 贴截图 / 完成 / 跳过 / 失败、内联编辑、拖拽重排、插入、拆细、情况变了 → 重规划 diff、`wait` 步骤盯长任务、QB 面板与自由对话。
- 环境自动采集；坑与 skill：复盘提议 + 一键确认；第二个相似任务时 skill 与坑被用上（芯片可见）。
- 旁观模式基础版：从 dsh 会话整理 runbook → skill。
- 第一个 skill：**vLLM PD 分离部署**（用你现在的真实工作喂出来）。

**阶段 2 · 两个人（你 + 你的 PL）**
- 登录与用户；发任务给别人；委派步骤 → 委派行；打开对方 runbook（只读 + 留言）；问发起人 + 收件箱 + IM 卡片一键答；事件上浮；发起人摘要与卡住检测；server 托管 UI 远程模式（PL 不装本地也能用）。

**阶段 3 · 团队与成长**
- Skill 库审核流与版本 diff、团队级坑确认、疑似过期检测；成长页；渐进自动执行（跑顺的 skill 步骤整段自动跑）；embeddings 检索；提示词评测集与回归；server 上 headless dsh 做复盘/摘要；OIDC；离线节点的本地队列；桌面打包（沿用 dsh-desktop 或 Tauri）。

---

## 10. 验证方式

- **单元**（`@qb/core`）：runbook schema 校验、预期检查（退出码 / 正则 / 包含）、runbook diff 与版本、事件上浮规则、破坏性命令模式、脱敏。
- **集成**：`dsh --profile qb web` 能加载 `@qb/dsh-qb`；工具可被模型调用且 schema 生效；`session/event` 同步到 server；UI 经 RPC 触发 `qb.step.run` 并收到流式输出与超时；`wait` 步骤轮询到就绪。
- **端到端 dogfood 脚本**（阶段 1 的完成定义）：
  1. 新任务"在测试集群跑通 vLLM PD 分离" → QB 起草 ≥ 8 步，每步有命令/预期/预计耗时，顶部有假设列表；
  2. 一步用 [▶运行]，一步用 [⧉复制] + 粘贴文本，一步贴截图 → 三种证据都正确归档、预期判断正确；
  3. 故意用错端口制造失败 → QB 从预置的坑里提议修法 → 一键应用重跑通过；
  4. 拖拽重排两步 + "情况变了：审批人不在" → 得到重规划 diff → 接受；
  5. 完成 → 复盘提议 ≥ 1 个坑 + skill「PD 分离部署」→ 确认；
  6. 再建一个相似任务 → 起草直接基于该 skill，相关步骤显示上一步沉淀的坑。
- **提示词评测**：3–5 个真实任务的金标准 runbook（结构、覆盖的关键步骤、预期是否可验证）作为回归集，`pnpm eval` 跑模型对比。
- **阶段 2 验收**：PL 在 IM 里一句话回答你的求助，答案出现在你的步骤里并可一键沉淀；PL 的 runbook 委派行实时反映你的进度。

---

## 11. 已决定的默认值（可在审阅时推翻）

- 术语：任务 / Runbook / 步骤 / Skill / Tool / 环境 / 坑 / 求助 / 事件。
- 界面与提示词中文，代码与标识符英文。
- 主题"轻"：QB、灵魂宝石健康度，其余不套隐喻。
- 知识确认：个人立即生效，团队需负责人确认，未确认对他人可见但标注。
- 单人 dogfood 阶段不做登录页，数据模型从第一天就是多用户的。
