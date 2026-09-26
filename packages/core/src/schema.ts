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

export const Runbook = z.object({
  id: Id,
  taskId: Id,
  version: z.number().int().positive(),
  createdBy: Id,
  createdAt: Timestamp,
  assumptions: z.array(Assumption),
  sourceSkillId: Id.nullable(),
  sourceSkillVersion: z.number().int().positive().nullable(),
})
export type Runbook = z.infer<typeof Runbook>

// ── 步骤 ───────────────────────────────────────────────────────────

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
  /** 说明、链接、图片。 */
  'note',
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
  /** 为什么要做这步，一句话。 */
  whyMd: z.string().nullable(),
  /** 出处，如 "skill:pd-deploy§3" 或 "lesson:xxx"。 */
  whySource: z.string().nullable(),
  command: z.string().nullable(),
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
})
export type Step = z.infer<typeof Step>

/** 允许人直接编辑的步骤字段。 */
export const StepPatch = z.object({
  kind: StepKind.optional(),
  title: z.string().min(1).optional(),
  whyMd: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  expectation: Expectation.nullable().optional(),
  probe: ReadinessProbe.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
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
  'lesson_proposed',
  'lesson_confirmed',
  'replanned',
  'task_started',
  'task_done',
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

/** 坑锚定在哪：优先锚到 skill 的具体某步，其次环境，最后自由。 */
export const LessonAnchor = z.enum(['skill_step', 'environment', 'free'])
export type LessonAnchor = z.infer<typeof LessonAnchor>

/** personal = 作者自己立即生效；team = 负责人确认后全队可见。 */
export const LessonScope = z.enum(['personal', 'team'])
export type LessonScope = z.infer<typeof LessonScope>

export const Lesson = z.object({
  id: Id,
  anchorKind: LessonAnchor,
  /** skill_step → "skillId:stepTitle"；environment → envId；free → null。 */
  anchorRef: z.string().nullable(),
  condition: z.string().nullable(),
  symptom: z.string(),
  cause: z.string().nullable(),
  fixMd: z.string(),
  /** 下次起草时该怎么改计划。 */
  nextTimeMd: z.string().nullable(),
  authorId: Id,
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
