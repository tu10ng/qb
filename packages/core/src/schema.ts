import { z } from 'zod'

/** 所有 id 都是 nanoid 字符串。 */
export const Id = z.string().min(1)
/** epoch 毫秒。 */
export const Timestamp = z.number().int()

// ── 用户 ───────────────────────────────────────────────────────────

export const User = z.object({
  id: Id,
  name: z.string().min(1),
  displayName: z.string().min(1),
  createdAt: Timestamp,
})
export type User = z.infer<typeof User>

// ── 任务 ───────────────────────────────────────────────────────────

/**
 * 任务状态。draft 是 QB 起草完但执行者还没动过的状态；
 * 第一次运行或编辑即转 active（没有"接受任务"这种仪式）。
 */
export const TaskStatus = z.enum(['draft', 'active', 'blocked', 'done', 'abandoned'])
export type TaskStatus = z.infer<typeof TaskStatus>

export const Task = z.object({
  id: Id,
  title: z.string().min(1),
  /** 发起人写的那段话，就是给 agent 的 prompt。 */
  briefMd: z.string(),
  initiatorId: Id,
  assigneeId: Id,
  /** 非空 = 由某一步委派产生。递归层级就靠它，不需要组织架构配置。 */
  parentStepId: Id.nullable(),
  status: TaskStatus,
  expectedMinutes: z.number().int().positive().nullable(),
  dueAt: Timestamp.nullable(),
  definitionOfDone: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
})
export type Task = z.infer<typeof Task>

/** 建完任务之后能改的信息：说明、发起人、预期都是边做边补的，不在建任务时强填。 */
export const TaskPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  briefMd: z.string().max(20_000).optional(),
  /** 发起人的名字；空串 = 自己。 */
  initiatorName: z.string().trim().max(40).optional(),
  expectedMinutes: z.number().int().positive().nullable().optional(),
  definitionOfDone: z.string().max(2000).nullable().optional(),
})
export type TaskPatch = z.infer<typeof TaskPatch>

// ── Runbook ────────────────────────────────────────────────────────

/**
 * QB 起草时对模糊之处所做的假设。不追问用户，而是写在 runbook 顶部供修改。
 */
export const Assumption = z.object({
  key: z.string(),
  value: z.string(),
  /** 用户改过的假设不会被后续重规划覆盖。 */
  editedByUser: z.boolean().default(false),
})
export type Assumption = z.infer<typeof Assumption>

// ── 参数（M7）───────────────────────────────────────────────

/**
 * 参数值的来源——界面据此分组展示与高亮：
 * origin=逐字来自贴进来的素材；base=从底稿复制；mine=用户改过；
 * qb_guess=QB 猜的、待确认；env=从环境事实取的。
 */
export const ParamSource = z.enum(['origin', 'base', 'mine', 'qb_guess', 'env'])
export type ParamSource = z.infer<typeof ParamSource>

/**
 * 参数名：原来的大写下划线（DECODE_HOST），或带中文的名字（容器名、机器195）。
 * 纯小写英文不算——{{name}} 这种多半是 jinja / mustache 模板，不能当成参数
 * 拦住运行。不以数字开头；点留给字段（{{机器195.密码}}）。
 */
export const PARAM_NAME_SRC = String.raw`(?:[A-Z_][A-Z0-9_]*|(?=[\p{L}\p{N}_]*[^\x00-\x7f])[\p{L}_][\p{L}\p{N}_]*)`
/** 字段名：任何字母开头（IP、用户、密码、port 都行）。 */
export const FIELD_KEY_SRC = String.raw`[\p{L}_][\p{L}\p{N}_]*`
export const PARAM_NAME_RE = new RegExp(`^${PARAM_NAME_SRC}$`, 'u')
const ParamName = z.string().regex(PARAM_NAME_RE, '参数名用大写英文、数字、下划线（如 DECODE_HOST），或带中文（如 容器名、机器195）；不能以数字开头')

/** 参数的一个字段（一台机器的 IP / 用户 / 密码）。 */
export const ParamField = z.object({
  key: z.string().regex(new RegExp(`^${FIELD_KEY_SRC}$`, 'u'), '字段名只能用字母（含中文）、数字和下划线'),
  value: z.string(),
  secret: z.boolean().default(false),
})
export type ParamField = z.infer<typeof ParamField>

export const Param = z.object({
  /** 模板里写 {{名字}}；有字段时写 {{名字.字段}}。 */
  name: ParamName,
  /** 主值：{{名字}} 渲染成它（机器参数就是 IP）。 */
  value: z.string(),
  description: z.string().optional(),
  source: ParamSource,
  /** secret 只存本机：界面打码、证据脱敏、永不上传。 */
  secret: z.boolean().default(false),
  /** 一组相关取值，比如贴进来的 "IP 用户 密码" 一行。 */
  fields: z.array(ParamField).optional(),
  /** 主值的标签（机器参数是 "IP"）：{{名字.IP}} 也能取到主值。 */
  valueLabel: z.string().optional(),
  /**
   * 归到哪一章（章节步骤的血缘）；空 = 整份文档。只影响在哪里显示——
   * 名字在整份 runbook 里唯一，渲染不看它。
   */
  scope: z.string().nullable().optional(),
})
export type Param = z.infer<typeof Param>

export const Runbook = z.object({
  id: Id,
  taskId: Id,
  version: z.number().int().positive(),
  createdBy: Id,
  createdAt: Timestamp,
  assumptions: z.array(Assumption),
  /**
   * 参数表（M7+）。命令模板里的 {{NAME}} 在这里取值。
   * 空白起草走的仍是 assumptions；导入/底稿路径写 params。
   */
  params: z.array(Param).default([]),
  /** 从哪份 runbook 复制/差异而来（模式 A 的"底稿"）。 */
  baseRunbookId: Id.nullable(),
  /** 从哪份素材整理而来（模式 B）——保真报告对着它比。 */
  materialId: Id.nullable(),
  /** 这份 runbook 怎么来的：import=贴素材让 QB 整理，doc=导入 md/org 文件，
   * copy=以底稿为基础，adapt=在底稿上应用过差异，draft=空白起草，human=自己写。 */
  origin: z.enum(['import', 'doc', 'copy', 'adapt', 'draft', 'human']).nullable(),
  /**
   * 文档血缘：同一任务的各版本、从它复制出来的 runbook 共用。挂在整份
   * 文档上的问答锚在它上面，跟着复制品走。
   */
  lineageKey: z.string().nullable().default(null),
  sourceSkillId: Id.nullable(),
  sourceSkillVersion: z.number().int().positive().nullable(),
})
export type Runbook = z.infer<typeof Runbook>

// ── 步骤 ───────────────────────────────────────────────────────────

/**
 * runbook 是一份可以执行的手册：前六种是要"做"的步骤（有完成/跳过/失败），
 * 后四种是文档内容（章节、文字、代码、回显），只读、可复制，不算进度。
 */
export const StepKind = z.enum([
  /** 一条命令，可点运行也可复制手动跑。 */
  'command',
  /** 验证某事，语义同 command 但失败不阻塞，用于确认状态。 */
  'check',
  /** 长任务：起服务、下模型、等外部审批。QB 轮询就绪条件。 */
  'wait',
  /** 只有人能做：找人、点网页、做判断。 */
  'manual',
  /** 委派给别人，生成对方的任务。 */
  'delegate',
  /** 需要发起人或专家拍板，变成一条求助。 */
  'decision',
  /** 章节：任意层级，下面可以放任何块。 */
  'section',
  /** 文字：markdown（说明、链接、图片、表格）。 */
  'note',
  /** 代码/配置片段（带语言）：复制用，不运行。 */
  'code',
  /** 回显/日志片段：参考用，不运行。 */
  'output',
])
export type StepKind = z.infer<typeof StepKind>

export const StepStatus = z.enum(['pending', 'running', 'ok', 'failed', 'skipped', 'blocked'])
export type StepStatus = z.infer<typeof StepStatus>

/**
 * 步骤内容从哪来。宪法 12：人写内容，QB 管结构——所以界面上要能一眼
 * 看出哪些命令是人写的、哪些是 QB 猜的。
 */
export const StepOrigin = z.enum([
  /** 人在界面上新加的。 */
  'human',
  /** 从用户贴进来的素材里整理出来的，命令逐字来自原文。 */
  'import',
  /** 从底稿（上次的执行、同事的 runbook）复制来的。 */
  'base',
  /** QB 自己写的（空白起草）。 */
  'qb',
])
export type StepOrigin = z.infer<typeof StepOrigin>

/** 预期检查方式。确定性的先判，unclear 才唤醒模型。 */
export const Expectation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exitCode'), code: z.number().int() }),
  z.object({ kind: z.literal('contains'), text: z.string(), caseSensitive: z.boolean().default(true) }),
  z.object({ kind: z.literal('regex'), pattern: z.string(), flags: z.string().default('') }),
  z.object({ kind: z.literal('notContains'), text: z.string() }),
  /** 人工确认，或需要模型读输出判断。 */
  z.object({ kind: z.literal('manual'), description: z.string() }),
])
export type Expectation = z.infer<typeof Expectation>

/** wait 步骤的就绪探针。 */
export const ReadinessProbe = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), url: z.string(), expectStatus: z.number().int().default(200) }),
  z.object({ kind: z.literal('port'), host: z.string(), port: z.number().int() }),
  z.object({ kind: z.literal('logPattern'), pattern: z.string() }),
  z.object({ kind: z.literal('command'), command: z.string(), expectExitCode: z.number().int().default(0) }),
])
export type ReadinessProbe = z.infer<typeof ReadinessProbe>

export const Step = z.object({
  id: Id,
  runbookId: Id,
  parentId: Id.nullable(),
  /** 分数索引：拖拽重排只改被移动的一行，不重写兄弟节点。 */
  orderKey: z.string().min(1),
  kind: StepKind,
  title: z.string().min(1),
  /**
   * 标题是按内容自动取的（导入/粘贴来的块没有标题）：界面不单独显示，
   * 内容一改就跟着重算；人写了标题就不再自动。
   */
  titleAuto: z.boolean().default(false),
  /** 为什么要做这步，一句话。 */
  whyMd: z.string().nullable(),
  /** 出处，如 "skill:pd-deploy§3" 或 "lesson:xxx"。 */
  whySource: z.string().nullable(),
  /** 命令/代码/回显的正文（command 与 code 按参数渲染，output 原样）。 */
  command: z.string().nullable(),
  /** 文字块的 markdown。 */
  bodyMd: z.string().nullable().default(null),
  /** 命令/代码的语言（bash、python、json……），决定高亮。 */
  lang: z.string().nullable().default(null),
  /** 参考回显：跑完应该看到什么（文本围栏或截图的 markdown），随文档复制。 */
  refMd: z.string().nullable().default(null),
  envId: Id.nullable(),
  expectation: Expectation.nullable(),
  probe: ReadinessProbe.nullable(),
  timeoutMs: z.number().int().positive().nullable(),
  expectedMinutes: z.number().positive().nullable(),
  status: StepStatus,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  actualMs: z.number().int().nonnegative().nullable(),
  /** kind=delegate 时指向子任务。 */
  delegateTaskId: Id.nullable(),
  /** 乐观并发：每次编辑 +1，保存时带上读到的值，不一致说明别处改过。 */
  rev: z.number().int().nonnegative(),
  /**
   * 步骤血缘：创建时生成，复制底稿时保留。坑挂在血缘上，所以别人在
   * 同一份底稿里记的坑，会出现在所有复制品的同一步上。
   */
  lineageKey: z.string().nullable(),
  origin: StepOrigin,
  /** 人改过内容时记下是谁；界面据此显示"我改的"。 */
  editedBy: Id.nullable(),
  /** 出处：素材 id + 片段。 */
  sourceRef: z.string().nullable(),
  /** 跳过或标记失败时写的一句原因。 */
  statusNote: z.string().nullable(),
  /** 共享输出给发起人（默认关；开启后最新输出随快照同步）。 */
  shareOutput: z.boolean().default(false),
})
export type Step = z.infer<typeof Step>

/** 允许人直接编辑的步骤字段。 */
export const StepPatch = z.object({
  kind: StepKind.optional(),
  title: z.string().min(1).optional(),
  /** true = 标题改回按内容自动取。 */
  titleAuto: z.boolean().optional(),
  whyMd: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  bodyMd: z.string().nullable().optional(),
  lang: z.string().max(40).nullable().optional(),
  refMd: z.string().nullable().optional(),
  expectation: Expectation.nullable().optional(),
  probe: ReadinessProbe.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
  shareOutput: z.boolean().optional(),
})
export type StepPatch = z.infer<typeof StepPatch>

// ── 证据 ───────────────────────────────────────────────────────────

export const EvidenceSource = z.enum(['auto', 'paste', 'image'])
export type EvidenceSource = z.infer<typeof EvidenceSource>

export const Evidence = z.object({
  id: Id,
  stepId: Id,
  source: EvidenceSource,
  text: z.string().nullable(),
  imagePath: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().default(false),
  durationMs: z.number().int().nonnegative().nullable(),
  /** 是否经过脱敏处理。 */
  redacted: z.boolean().default(false),
  createdAt: Timestamp,
})
export type Evidence = z.infer<typeof Evidence>

// ── 事件 ───────────────────────────────────────────────────────────

export const EventKind = z.enum([
  'step_run',
  'step_ok',
  'step_failed',
  'step_timeout',
  'step_skipped',
  'edit',
  'reorder',
  'insert',
  'step_deleted',
  'step_restored',
  'situation_changed',
  'question_asked',
  'question_answered',
  'delegate_progress',
  'comment',
  'alert_acked',
  'lesson_proposed',
  'lesson_confirmed',
  'lesson_shared',
  'base_proposal',
  'replanned',
  'task_created',
  /** 改了任务信息（标题、说明、发起人、预期）。 */
  'task_updated',
  'task_started',
  'task_done',
  /** 执行者点了"卡住了"；payload.note 是一句原因。 */
  'task_blocked',
  /** 从卡住恢复（手动点"继续"，或卡住后又开始执行，payload.auto=true）。 */
  'task_resumed',
  'task_abandoned',
  /** 完成/放弃之后重新打开。 */
  'task_reopened',
  /** QB 替执行者告诉了发起人（宪法 15：执行者看得到 QB 替他说了什么）。 */
  'alert_raised',
  /** 执行者说"我能搞定"：这条告警静音一段时间。 */
  'alert_snoozed',
])
export type EventKind = z.infer<typeof EventKind>

export const Event = z.object({
  id: Id,
  taskId: Id,
  stepId: Id.nullable(),
  actorId: Id.nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
})
export type Event = z.infer<typeof Event>

// ── Skill ──────────────────────────────────────────────────────────

export const Skill = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string(),
  appliesWhen: z.string().nullable(),
  ownerId: Id.nullable(),
  currentVersion: z.number().int().positive(),
  createdAt: Timestamp,
})
export type Skill = z.infer<typeof Skill>

/** 每步耗时统计，用于校准 expectedMinutes 和 timeoutMs。 */
export const StepStats = z.object({
  stepTitle: z.string(),
  runs: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  medianMs: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
})
export type StepStats = z.infer<typeof StepStats>

export const SkillVersion = z.object({
  id: Id,
  skillId: Id,
  version: z.number().int().positive(),
  /** 模板化的步骤树，带变量占位。 */
  template: z.unknown(),
  stats: z.array(StepStats),
  sourceRunbookId: Id.nullable(),
  createdBy: Id,
  createdAt: Timestamp,
})
export type SkillVersion = z.infer<typeof SkillVersion>

// ── 坑 ─────────────────────────────────────────────────────────────

/**
 * 问答（原"坑"）锚定在哪：步骤或章节的血缘（同血缘的所有复制品都看得见）、
 * 整份文档的血缘、环境，或者不挂靠（只进检索）。
 */
export const LessonAnchor = z.enum(['skill_step', 'environment', 'free', 'step_lineage', 'runbook_lineage'])
export type LessonAnchor = z.infer<typeof LessonAnchor>

/** personal = 作者自己立即生效；team = 负责人确认后全队可见。 */
export const LessonScope = z.enum(['personal', 'team'])
export type LessonScope = z.infer<typeof LessonScope>

export const Lesson = z.object({
  id: Id,
  anchorKind: LessonAnchor,
  /** skill_step → "skillId:stepTitle"；step_lineage → lineageKey；runbook_lineage → 文档血缘；environment → envId；free → null。 */
  anchorRef: z.string().nullable(),
  condition: z.string().nullable(),
  /** 问（原"症状"）。问和答至少有一个，另一个可以空着。 */
  symptom: z.string(),
  cause: z.string().nullable(),
  /** 答（原"修法"）。空着的问可以拿去问发起人，回答回来就填上。 */
  fixMd: z.string(),
  /** 下次起草时该怎么改计划。 */
  nextTimeMd: z.string().nullable(),
  authorId: Id,
  /** 远程（团队同步下来）的坑带作者名；本地的为 null，界面查 users 表。 */
  authorName: z.string().nullable().default(null),
  sourceTaskId: Id.nullable(),
  scope: LessonScope,
  confirmedBy: Id.nullable(),
  confirmedAt: Timestamp.nullable(),
  hitCount: z.number().int().nonnegative().default(0),
  missCount: z.number().int().nonnegative().default(0),
  /** 连续失效后标记疑似过期。 */
  staleAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Lesson = z.infer<typeof Lesson>

// ── 环境 ───────────────────────────────────────────────────────────

export const EnvironmentFacts = z.object({
  os: z.string().optional(),
  shell: z.string().optional(),
  arch: z.string().optional(),
  gpu: z.string().optional(),
  cuda: z.string().optional(),
  paths: z.record(z.string(), z.string()).optional(),
  proxy: z.string().optional(),
  quirks: z.array(z.string()).optional(),
})
export type EnvironmentFacts = z.infer<typeof EnvironmentFacts>

export const Environment = z.object({
  id: Id,
  name: z.string().min(1),
  facts: EnvironmentFacts,
  ownerId: Id.nullable(),
  collectedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Environment = z.infer<typeof Environment>

// ── 求助 ───────────────────────────────────────────────────────────

export const QuestionOption = z.object({
  label: z.string(),
  /** 选这个选项后建议的动作，如 "retry" / "skip" / "edit:2.3"。 */
  action: z.string().nullable(),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const Question = z.object({
  id: Id,
  taskId: Id,
  stepId: Id.nullable(),
  askerId: Id,
  targetId: Id.nullable(),
  /** QB 代拟的正文，带完整上下文。用户可改可直发。 */
  bodyMd: z.string(),
  options: z.array(QuestionOption),
  answerMd: z.string().nullable(),
  answeredBy: Id.nullable(),
  answeredAt: Timestamp.nullable(),
  /** 答复沉淀成的坑。 */
  lessonId: Id.nullable(),
  createdAt: Timestamp,
})
export type Question = z.infer<typeof Question>
