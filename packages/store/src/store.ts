import {
  ids,
  orderKeyBetween,
  type Assumption,
  type Environment,
  type EnvironmentFacts,
  type Event,
  type Evidence,
  type EvidenceSource,
  type EventKind,
  type Expectation,
  type Lesson,
  type LessonAnchor,
  type LessonScope,
  type Param,
  type ReadinessProbe,
  type Runbook,
  type Skill,
  type Step,
  type StepKind,
  type StepOrigin,
  type StepPatch,
  type StepStatus,
  type Task,
  type TaskStatus,
  type User,
} from '@qb/core'
import type { Db } from './db.ts'

/** 保存时带的 rev 与库里不一致：别的标签页或别人先改了。 */
export class RevConflict extends Error {
  readonly current: Step

  constructor(current: Step) {
    super('这一步已经在别处被改过，已为你载入最新内容')
    this.name = 'RevConflict'
    this.current = current
  }
}

/** 一处字段改动，写进 edit 事件供复盘与撤销。 */
export interface FieldChange {
  field: keyof StepPatch
  before: unknown
  after: unknown
}

/** 本机保存的模型档案（原样的行数据；业务含义由 engine 解释）。 */
export interface StoredModelProfile {
  id: string
  name: string
  preset: string
  wire: string
  baseUrl: string
  apiKey: string
  model: string
  options: Record<string, unknown>
  capabilities: unknown
  createdAt: number
  updatedAt: number
}

/**
 * FTS5 查询分词。
 *
 * 中文按字切、英文按词切，拼成 OR 查询。过滤掉 FTS 语法字符，
 * 否则用户任务标题里的引号、星号会让查询直接报错。
 */
function tokenize(text: string): string[] {
  const cleaned = text.replace(/["*()^:-]/g, ' ')
  const out = new Set<string>()

  for (const m of cleaned.matchAll(/[a-zA-Z][a-zA-Z0-9_.]*|\d+/g)) {
    if (m[0].length >= 2) out.add(m[0].toLowerCase())
  }
  for (const m of cleaned.matchAll(/[一-鿿]/g)) {
    out.add(m[0])
  }

  return [...out].slice(0, 40)
}

/**
 * 任务 / Runbook / 步骤 / 事件的读写。
 *
 * 所有跨行写入都在事务里，避免出现"runbook 建了但步骤没建"这种
 * 半截状态——那会让界面显示一个空的 runbook，用户无从判断是 QB
 * 没起草还是出错了。
 */
export class Store {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // ── 用户 ─────────────────────────────────────────────────────

  createUser(input: { name: string; displayName?: string }): User {
    const user: User = {
      id: ids.user(),
      name: input.name,
      displayName: input.displayName ?? input.name,
      createdAt: Date.now(),
    }
    this.db
      .prepare('INSERT INTO users (id, name, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.name, user.displayName, user.createdAt)
    return user
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | UserRow
      | undefined
    return row === undefined ? null : toUser(row)
  }

  getUserByName(name: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as
      | UserRow
      | undefined
    return row === undefined ? null : toUser(row)
  }

  /** 单人 dogfood 用：没有就建一个，不需要注册流程。 */
  ensureUser(name: string, displayName?: string): User {
    return this.getUserByName(name) ?? this.createUser({ name, ...(displayName !== undefined ? { displayName } : {}) })
  }

  // ── 任务 ─────────────────────────────────────────────────────

  createTask(input: {
    title: string
    briefMd?: string
    initiatorId: string
    assigneeId?: string
    parentStepId?: string | null
    expectedMinutes?: number | null
    dueAt?: number | null
    definitionOfDone?: string | null
  }): Task {
    const task: Task = {
      id: ids.task(),
      title: input.title,
      briefMd: input.briefMd ?? '',
      initiatorId: input.initiatorId,
      // 默认派给自己：单人使用时不该有"选择执行者"这一步
      assigneeId: input.assigneeId ?? input.initiatorId,
      parentStepId: input.parentStepId ?? null,
      status: 'draft',
      expectedMinutes: input.expectedMinutes ?? null,
      dueAt: input.dueAt ?? null,
      definitionOfDone: input.definitionOfDone ?? null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    }

    this.db
      .prepare(
        `INSERT INTO tasks
         (id, title, brief_md, initiator_id, assignee_id, parent_step_id, status,
          expected_minutes, due_at, definition_of_done, created_at)
         VALUES (@id, @title, @briefMd, @initiatorId, @assigneeId, @parentStepId, @status,
                 @expectedMinutes, @dueAt, @definitionOfDone, @createdAt)`,
      )
      .run(task)

    return task
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row === undefined ? null : toTask(row)
  }

  listTasks(filter: { assigneeId?: string; initiatorId?: string; status?: TaskStatus } = {}): Task[] {
    const where: string[] = ['archived_at IS NULL']
    const params: Record<string, unknown> = {}

    if (filter.assigneeId !== undefined) {
      where.push('assignee_id = @assigneeId')
      params.assigneeId = filter.assigneeId
    }
    if (filter.initiatorId !== undefined) {
      where.push('initiator_id = @initiatorId')
      params.initiatorId = filter.initiatorId
    }
    if (filter.status !== undefined) {
      where.push('status = @status')
      params.status = filter.status
    }

    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
      .all(params) as TaskRow[]
    return rows.map(toTask)
  }

  /**
   * 首次执行或编辑时把任务从 draft 推进到 active。
   * 没有"接受任务"这种仪式——动手即开始。
   */
  markTaskStarted(taskId: string, actorId: string): void {
    const task = this.getTask(taskId)
    if (task === null || task.status !== 'draft') return

    this.db
      .prepare("UPDATE tasks SET status = 'active', started_at = ? WHERE id = ?")
      .run(Date.now(), taskId)
    this.appendEvent({ taskId, actorId, kind: 'task_started', payload: {} })
  }

  updateTaskStatus(taskId: string, status: TaskStatus, actorId: string | null): void {
    const ended = status === 'done' || status === 'abandoned' ? Date.now() : null
    this.db
      .prepare('UPDATE tasks SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?')
      .run(status, ended, taskId)
    if (status === 'done') {
      this.appendEvent({ taskId, actorId, kind: 'task_done', payload: {} })
    }
  }

  // ── Runbook ──────────────────────────────────────────────────

  /**
   * 建一个新版本的 runbook 并写入步骤树。
   *
   * 每次 QB 重规划或人编辑结构都产生新版本——这正是"为什么上次
   * 分解得不对"能回答得了的原因：旧版本连同事件一起留着。
   */
  createRunbook(input: {
    taskId: string
    createdBy: string
    assumptions?: Assumption[]
    /** 参数表（M7+，导入/底稿路径）。 */
    params?: Param[]
    /** 底稿：这份 runbook 从哪份复制/差异而来。 */
    baseRunbookId?: string | null
    /** 素材：这份 runbook 从哪份素材整理而来（保真对着它比）。 */
    materialId?: string | null
    origin?: Runbook['origin']
    sourceSkillId?: string | null
    sourceSkillVersion?: number | null
    /** 这批步骤的来源；单个步骤可在 NewStep 里覆盖。默认 human。 */
    steps: NewStep[]
  }): { runbook: Runbook; steps: Step[] } {
    const run = this.db.transaction(() => {
      const prev = this.db
        .prepare('SELECT MAX(version) v FROM runbooks WHERE task_id = ?')
        .get(input.taskId) as { v: number | null }
      const version = (prev.v ?? 0) + 1

      const runbook: Runbook = {
        id: ids.runbook(),
        taskId: input.taskId,
        version,
        createdBy: input.createdBy,
        createdAt: Date.now(),
        assumptions: input.assumptions ?? [],
        params: input.params ?? [],
        baseRunbookId: input.baseRunbookId ?? null,
        materialId: input.materialId ?? null,
        origin: input.origin ?? null,
        sourceSkillId: input.sourceSkillId ?? null,
        sourceSkillVersion: input.sourceSkillVersion ?? null,
      }

      this.db
        .prepare(
          `INSERT INTO runbooks
           (id, task_id, version, created_by, created_at, assumptions_json, params_json,
            base_runbook_id, material_id, origin, source_skill_id, source_skill_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runbook.id,
          runbook.taskId,
          runbook.version,
          runbook.createdBy,
          runbook.createdAt,
          JSON.stringify(runbook.assumptions),
          JSON.stringify(runbook.params),
          runbook.baseRunbookId,
          runbook.materialId,
          runbook.origin,
          runbook.sourceSkillId,
          runbook.sourceSkillVersion,
        )

      // 步骤默认来源跟着 runbook 来源走：import→逐字来自素材，copy/adapt→
      // 来自底稿，draft→QB 写的，没说就是人写的
      const stepOrigin: StepOrigin =
        input.origin === 'import'
          ? 'import'
          : input.origin === 'copy' || input.origin === 'adapt'
            ? 'base'
            : input.origin === 'draft'
              ? 'qb'
              : 'human'
      const steps = this.insertStepTree(runbook.id, null, input.steps, stepOrigin)
      return { runbook, steps }
    })

    return run()
  }

  /** 覆盖参数表（值的就地修改、同值联动、差异应用都走这里）。 */
  updateRunbookParams(runbookId: string, params: Param[], origin?: Runbook['origin']): void {
    this.db
      .prepare(
        `UPDATE runbooks SET params_json = ?${origin !== undefined ? ', origin = ?' : ''} WHERE id = ?`,
      )
      .run(JSON.stringify(params), ...(origin !== undefined ? [origin] : []), runbookId)
  }

  /**
   * 以一份 runbook 为底稿复制出新的（模式 A 的第一步）。
   *
   * 步骤保留血缘（origin=base）——挂在血缘上的坑跟着过来；参数值照抄
   * （source=base）——之后 adapt 出差异、逐项接受。
   */
  copyRunbook(baseRunbookId: string, taskId: string, actorId: string): { runbook: Runbook; steps: Step[] } {
    const base = this.db
      .prepare('SELECT * FROM runbooks WHERE id = ?')
      .get(baseRunbookId) as RunbookRow | undefined
    if (base === undefined) throw new Error('底稿不存在')

    const baseSteps = this.listSteps(baseRunbookId)
    const childrenOf = new Map<string | null, Step[]>()
    for (const s of baseSteps) {
      const list = childrenOf.get(s.parentId) ?? []
      list.push(s)
      childrenOf.set(s.parentId, list)
    }
    const toNew = (s: Step): NewStep => ({
      kind: s.kind,
      title: s.title,
      whyMd: s.whyMd,
      whySource: s.whySource,
      command: s.command,
      envId: s.envId,
      expectation: s.expectation,
      probe: s.probe,
      timeoutMs: s.timeoutMs,
      expectedMinutes: s.expectedMinutes,
      origin: 'base',
      ...(s.lineageKey !== null ? { lineageKey: s.lineageKey } : {}),
      ...(s.sourceRef !== null ? { sourceRef: s.sourceRef } : {}),
      ...(childrenOf.get(s.id) !== undefined ? { children: (childrenOf.get(s.id) ?? []).map(toNew) } : {}),
    })
    const top = (childrenOf.get(null) ?? []).map(toNew)

    const params = toRunbook(base).params.map((p) => ({ ...p, source: 'base' as const }))
    return this.createRunbook({
      taskId,
      createdBy: actorId,
      params,
      baseRunbookId,
      origin: 'copy',
      steps: top,
    })
  }

  // ── 素材（M7）：贴进来的原文，保真/覆盖/出处都对着它 ────────

  createMaterial(input: { taskId: string; kind: string; text: string; filename?: string; createdBy: string }): { id: string; createdAt: number } {
    const id = ids.material()
    // 时间戳严格递增：同一毫秒连贴两份素材时，latestMaterial 才不会挑错
    const last = this.db
      .prepare('SELECT MAX(created_at) m FROM materials WHERE task_id = ?')
      .get(input.taskId) as { m: number | null }
    const createdAt = Math.max(Date.now(), (last.m ?? 0) + 1)
    this.db
      .prepare(
        `INSERT INTO materials (id, task_id, kind, text, filename, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.taskId, input.kind, input.text, input.filename ?? null, input.createdBy, createdAt)
    return { id, createdAt }
  }

  getMaterial(id: string): { id: string; taskId: string; kind: string; text: string; filename: string | null; createdAt: number } | null {
    const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as
      | { id: string; task_id: string; kind: string; text: string; filename: string | null; created_at: number }
      | undefined
    if (row === undefined) return null
    return { id: row.id, taskId: row.task_id, kind: row.kind, text: row.text, filename: row.filename, createdAt: row.created_at }
  }

  /** 任务的素材里最近的一份（任务详情带出来供"从素材整理"）。 */
  latestMaterial(taskId: string): { id: string; kind: string; filename: string | null } | null {
    const row = this.db
      .prepare('SELECT id, kind, filename FROM materials WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as { id: string; kind: string; filename: string | null } | undefined
    return row === undefined ? null : { id: row.id, kind: row.kind, filename: row.filename }
  }

  /** 找底稿：按标题+描述全文检索任务。 */
  searchTasks(query: string, limit = 6): Task[] {
    const terms = tokenize(query)
    if (terms.length === 0) return []
    try {
      const rows = this.db
        .prepare(
          `SELECT t.* FROM tasks_fts f
           JOIN tasks t ON t.rowid = f.rowid
           WHERE tasks_fts MATCH ?
             AND t.archived_at IS NULL
           ORDER BY bm25(tasks_fts), t.created_at DESC
           LIMIT ?`,
        )
        .all(terms.join(' OR '), limit) as TaskRow[]
      return rows.map(toTask)
    } catch {
      return []
    }
  }

  /** 递归写入步骤树，自动生成 orderKey。 */
  private insertStepTree(
    runbookId: string,
    parentId: string | null,
    nodes: NewStep[],
    origin: StepOrigin,
  ): Step[] {
    const out: Step[] = []
    let prevKey: string | null = null

    for (const node of nodes) {
      const orderKey = orderKeyBetween(prevKey, null)
      prevKey = orderKey

      const step = this.insertStepRow(runbookId, parentId, orderKey, node, origin)
      out.push(step)
      if (node.children !== undefined && node.children.length > 0) {
        out.push(...this.insertStepTree(runbookId, step.id, node.children, origin))
      }
    }

    return out
  }

  private insertStepRow(
    runbookId: string,
    parentId: string | null,
    orderKey: string,
    node: NewStep,
    origin: StepOrigin,
  ): Step {
    const step: Step = {
      id: ids.step(),
      runbookId,
      parentId,
      orderKey,
      kind: node.kind,
      title: node.title,
      whyMd: node.whyMd ?? null,
      whySource: node.whySource ?? null,
      command: node.command ?? null,
      envId: node.envId ?? null,
      expectation: node.expectation ?? null,
      probe: node.probe ?? null,
      timeoutMs: node.timeoutMs ?? null,
      expectedMinutes: node.expectedMinutes ?? null,
      status: 'pending',
      startedAt: null,
      endedAt: null,
      actualMs: null,
      delegateTaskId: null,
      rev: 0,
      lineageKey: node.lineageKey ?? ids.lineage(),
      origin: node.origin ?? origin,
      editedBy: null,
      sourceRef: node.sourceRef ?? null,
      statusNote: null,
    }

    this.db
      .prepare(
        `INSERT INTO steps
         (id, runbook_id, parent_id, order_key, kind, title, why_md, why_source,
          command, env_id, expectation_json, probe_json, timeout_ms, expected_minutes, status,
          rev, lineage_key, origin, source_ref)
         VALUES (@id, @runbookId, @parentId, @orderKey, @kind, @title, @whyMd, @whySource,
                 @command, @envId, @expectationJson, @probeJson, @timeoutMs, @expectedMinutes, @status,
                 @rev, @lineageKey, @origin, @sourceRef)`,
      )
      .run({
        ...step,
        expectationJson: step.expectation === null ? null : JSON.stringify(step.expectation),
        probeJson: step.probe === null ? null : JSON.stringify(step.probe),
      })

    return step
  }

  getRunbook(id: string): Runbook | null {
    const row = this.db.prepare('SELECT * FROM runbooks WHERE id = ?').get(id) as RunbookRow | undefined
    return row === undefined ? null : toRunbook(row)
  }

  getLatestRunbook(taskId: string): { runbook: Runbook; steps: Step[] } | null {
    const row = this.db
      .prepare('SELECT * FROM runbooks WHERE task_id = ? ORDER BY version DESC LIMIT 1')
      .get(taskId) as RunbookRow | undefined
    if (row === undefined) return null

    return { runbook: toRunbook(row), steps: this.listSteps(row.id) }
  }

  listRunbookVersions(taskId: string): Runbook[] {
    const rows = this.db
      .prepare('SELECT * FROM runbooks WHERE task_id = ? ORDER BY version DESC')
      .all(taskId) as RunbookRow[]
    return rows.map(toRunbook)
  }

  // ── 步骤 ─────────────────────────────────────────────────────

  /**
   * 按树结构列出步骤：先序遍历，同层按 orderKey。
   *
   * orderKey 只在兄弟之间唯一（这是分数索引的正确语义），所以不能
   * 直接按它全局排序——那会让不同章节的子步骤混在一起。用递归 CTE
   * 拼出路径再排序，得到的就是用户在文档里看到的顺序。
   */
  listSteps(runbookId: string): Step[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree AS (
           SELECT s.*, s.order_key AS path, 0 AS depth
           FROM steps s
           WHERE s.runbook_id = ? AND s.parent_id IS NULL AND s.deleted_at IS NULL
           UNION ALL
           SELECT s.*, t.path || char(31) || s.order_key, t.depth + 1
           FROM steps s JOIN tree t ON s.parent_id = t.id
           WHERE s.deleted_at IS NULL
         )
         SELECT * FROM tree ORDER BY path`,
      )
      .all(runbookId) as StepRow[]
    return rows.map(toStep)
  }

  /** 已删除的步骤默认取不到：不能运行、不能编辑，只能撤销删除。 */
  getStep(id: string, opts: { includeDeleted?: boolean } = {}): Step | null {
    const row = this.db
      .prepare(
        opts.includeDeleted === true
          ? 'SELECT * FROM steps WHERE id = ?'
          : 'SELECT * FROM steps WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id) as StepRow | undefined
    return row === undefined ? null : toStep(row)
  }

  /** 从步骤反查它所属的任务。步骤只认 runbook，任务在 runbook 上。 */
  taskIdOfStep(stepId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.task_id AS taskId
         FROM steps s JOIN runbooks r ON r.id = s.runbook_id
         WHERE s.id = ?`,
      )
      .get(stepId) as { taskId: string } | undefined
    return row?.taskId ?? null
  }

  updateStepStatus(
    stepId: string,
    status: StepStatus,
    extra: { startedAt?: number; endedAt?: number; actualMs?: number; note?: string | null; resetTimings?: boolean } = {},
  ): void {
    // note 只在显式给出时覆盖：自动判定的状态变化不该抹掉人写的原因。
    // resetTimings（重置为未开始）则把三个时间字段清空——留着旧耗时
    // 会让"重来一遍"的步骤显示上一次的用时。
    const setNote = extra.note !== undefined
    const reset = extra.resetTimings === true ? 1 : 0
    this.db
      .prepare(
        `UPDATE steps SET status = ?,
           started_at  = CASE WHEN ? THEN NULL ELSE COALESCE(?, started_at) END,
           ended_at    = CASE WHEN ? THEN NULL ELSE COALESCE(?, ended_at) END,
           actual_ms   = CASE WHEN ? THEN NULL ELSE COALESCE(?, actual_ms) END,
           status_note = CASE WHEN ? THEN ? ELSE status_note END
         WHERE id = ?`,
      )
      .run(
        status,
        reset,
        extra.startedAt ?? null,
        reset,
        extra.endedAt ?? null,
        reset,
        extra.actualMs ?? null,
        setNote ? 1 : 0,
        extra.note ?? null,
        stepId,
      )
  }

  // ── 编辑：原地修改，每次编辑由调用方记一条 edit 事件 ──────────

  /**
   * 改一步的内容。
   *
   * 带上读到的 rev：不一致说明别的标签页先改了，抛 RevConflict 并附上
   * 最新内容，而不是静默覆盖别人的修改。没有实际变化时不动 rev。
   */
  updateStep(
    stepId: string,
    patch: StepPatch,
    opts: { expectedRev: number; actorId: string },
  ): { step: Step; changes: FieldChange[] } {
    const run = this.db.transaction(() => {
      const current = this.getStep(stepId)
      if (current === null) throw new Error('步骤不存在或已删除')
      if (current.rev !== opts.expectedRev) throw new RevConflict(current)

      const changes: FieldChange[] = []
      for (const field of Object.keys(patch) as Array<keyof StepPatch>) {
        const after = patch[field]
        if (after === undefined) continue
        const before = current[field]
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        changes.push({ field, before, after })
      }
      if (changes.length === 0) return { step: current, changes }

      const next: Step = { ...current }
      for (const c of changes) {
        ;(next as Record<string, unknown>)[c.field] = c.after
      }

      this.db
        .prepare(
          `UPDATE steps SET
             kind = @kind, title = @title, why_md = @whyMd, command = @command,
             expectation_json = @expectationJson, probe_json = @probeJson,
             timeout_ms = @timeoutMs, expected_minutes = @expectedMinutes,
             rev = rev + 1, edited_by = @editedBy
           WHERE id = @id`,
        )
        .run({
          id: stepId,
          kind: next.kind,
          title: next.title,
          whyMd: next.whyMd,
          command: next.command,
          expectationJson: next.expectation === null ? null : JSON.stringify(next.expectation),
          probeJson: next.probe === null ? null : JSON.stringify(next.probe),
          timeoutMs: next.timeoutMs,
          expectedMinutes: next.expectedMinutes,
          editedBy: opts.actorId,
        })

      return { step: this.getStep(stepId)!, changes }
    })
    return run()
  }

  /**
   * 在某个位置插入一步。
   *
   * afterId 为 null 表示放在该父节点下的最前面。算位置时把已删除的兄弟
   * 也算进去：新键严格落在相邻两个键之间，撤销删除时不会撞键。
   */
  insertStep(input: {
    runbookId: string
    parentId: string | null
    afterId: string | null
    step: NewStep
    origin?: StepOrigin
  }): Step {
    const run = this.db.transaction(() => {
      if (input.parentId !== null) this.assertStepInRunbook(input.parentId, input.runbookId)
      const orderKey = this.keyAfter(input.runbookId, input.parentId, input.afterId, null)
      const step = this.insertStepRow(
        input.runbookId,
        input.parentId,
        orderKey,
        input.step,
        input.origin ?? 'human',
      )
      if (input.step.children !== undefined && input.step.children.length > 0) {
        this.insertStepTree(input.runbookId, step.id, input.step.children, input.origin ?? 'human')
      }
      return step
    })
    return run()
  }

  /** 移动一步到新的父节点下、某个兄弟之后（afterId=null 表示最前面）。 */
  moveStep(
    stepId: string,
    to: { parentId: string | null; afterId: string | null },
    opts: { expectedRev: number },
  ): { step: Step; from: { parentId: string | null; orderKey: string } } {
    const run = this.db.transaction(() => {
      const current = this.getStep(stepId)
      if (current === null) throw new Error('步骤不存在或已删除')
      if (current.rev !== opts.expectedRev) throw new RevConflict(current)
      if (to.afterId === stepId) throw new Error('不能把步骤移到它自己后面')

      if (to.parentId !== null) {
        this.assertStepInRunbook(to.parentId, current.runbookId)
        // 不能移进自己的子树，否则整棵子树会从文档里消失
        if (this.isSelfOrDescendant(stepId, to.parentId)) {
          throw new Error('不能把步骤移到它自己的子步骤下面')
        }
      }

      const orderKey = this.keyAfter(current.runbookId, to.parentId, to.afterId, stepId)
      this.db
        .prepare('UPDATE steps SET parent_id = ?, order_key = ?, rev = rev + 1 WHERE id = ?')
        .run(to.parentId, orderKey, stepId)

      return {
        step: this.getStep(stepId)!,
        from: { parentId: current.parentId, orderKey: current.orderKey },
      }
    })
    return run()
  }

  /**
   * 删除一步及其子步骤（软删除，可撤销）。
   *
   * 同一次删除的所有行打同一个时间戳，撤销时按它整批恢复，不会把之前
   * 单独删掉的子步骤也一并带回来。
   */
  deleteStep(stepId: string): { ids: string[]; deletedAt: number } {
    const run = this.db.transaction(() => {
      const current = this.getStep(stepId)
      if (current === null) throw new Error('步骤不存在或已删除')

      // 时间戳兼作批次号，必须严格递增：同一毫秒内的两次删除若共用一个
      // 值，撤销其中一次会把另一次也带回来
      const last = this.db.prepare('SELECT MAX(deleted_at) m FROM steps').get() as { m: number | null }
      const deletedAt = Math.max(Date.now(), (last.m ?? 0) + 1)
      const rows = this.db
        .prepare(
          `WITH RECURSIVE sub AS (
             SELECT id FROM steps WHERE id = ?
             UNION ALL
             SELECT s.id FROM steps s JOIN sub ON s.parent_id = sub.id WHERE s.deleted_at IS NULL
           )
           SELECT id FROM sub`,
        )
        .all(stepId) as Array<{ id: string }>
      const ids = rows.map((r) => r.id)

      const stmt = this.db.prepare('UPDATE steps SET deleted_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(deletedAt, id)
      return { ids, deletedAt }
    })
    return run()
  }

  /**
   * 一步连同其子树的全部 id（不含已删除的行——正在执行的行不可能是
   * 已删除的）。删除章节前用它检查有没有正在跑的子孙。
   */
  subtreeIds(stepId: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub AS (
           SELECT id FROM steps WHERE id = ?
           UNION ALL
           SELECT s.id FROM steps s JOIN sub ON s.parent_id = sub.id WHERE s.deleted_at IS NULL
         )
         SELECT id FROM sub`,
      )
      .all(stepId) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** 撤销删除：恢复这一步和同一次被删掉的子步骤。 */
  restoreStep(stepId: string): { ids: string[] } {
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT deleted_at FROM steps WHERE id = ?').get(stepId) as
        | { deleted_at: number | null }
        | undefined
      if (row === undefined) throw new Error('步骤不存在')
      if (row.deleted_at === null) return { ids: [] }

      const rows = this.db
        .prepare(
          `WITH RECURSIVE sub AS (
             SELECT id FROM steps WHERE id = ?
             UNION ALL
             SELECT s.id FROM steps s JOIN sub ON s.parent_id = sub.id WHERE s.deleted_at = ?
           )
           SELECT id FROM sub`,
        )
        .all(stepId, row.deleted_at) as Array<{ id: string }>
      const ids = rows.map((r) => r.id)

      const stmt = this.db.prepare('UPDATE steps SET deleted_at = NULL WHERE id = ?')
      for (const id of ids) stmt.run(id)
      return { ids }
    })
    return run()
  }

  /** QB 大改之前留快照：导入、调整差异、重规划都原地应用，快照是回退与对比的依据。 */
  snapshotRunbook(runbookId: string, reason: string, actorId: string | null): string {
    const id = ids.snapshot()
    this.db
      .prepare(
        `INSERT INTO runbook_snapshots (id, runbook_id, reason, steps_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runbookId, reason, JSON.stringify(this.listSteps(runbookId)), actorId, Date.now())
    return id
  }

  listSnapshots(runbookId: string): Array<{ id: string; reason: string; createdAt: number; steps: Step[] }> {
    const rows = this.db
      .prepare(
        'SELECT id, reason, steps_json, created_at FROM runbook_snapshots WHERE runbook_id = ? ORDER BY created_at DESC',
      )
      .all(runbookId) as Array<{ id: string; reason: string; steps_json: string; created_at: number }>
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      createdAt: r.created_at,
      steps: JSON.parse(r.steps_json) as Step[],
    }))
  }

  /** 父节点下 afterId 之后的位置键。excludeId：移动时排除自己。 */
  private keyAfter(
    runbookId: string,
    parentId: string | null,
    afterId: string | null,
    excludeId: string | null,
  ): string {
    // 已删除的兄弟也要算：新键必须避开它们，撤销删除后顺序才不会乱
    const siblings = (
      this.db
        .prepare(
          `SELECT id, order_key FROM steps
           WHERE runbook_id = ? AND parent_id IS ?
           ORDER BY order_key`,
        )
        .all(runbookId, parentId) as Array<{ id: string; order_key: string }>
    ).filter((s) => s.id !== excludeId)

    if (afterId === null) {
      return orderKeyBetween(null, siblings[0]?.order_key ?? null)
    }

    const idx = siblings.findIndex((s) => s.id === afterId)
    if (idx < 0) throw new Error('要插在它后面的那一步不在同一层')
    return orderKeyBetween(siblings[idx]!.order_key, siblings[idx + 1]?.order_key ?? null)
  }

  private assertStepInRunbook(stepId: string, runbookId: string): void {
    const row = this.db
      .prepare('SELECT runbook_id FROM steps WHERE id = ? AND deleted_at IS NULL')
      .get(stepId) as { runbook_id: string } | undefined
    if (row === undefined || row.runbook_id !== runbookId) {
      throw new Error('父步骤不存在或不在这份 runbook 里')
    }
  }

  private isSelfOrDescendant(rootId: string, candidateId: string): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE sub AS (
           SELECT id FROM steps WHERE id = ?
           UNION ALL
           SELECT s.id FROM steps s JOIN sub ON s.parent_id = sub.id
         )
         SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
      )
      .get(rootId, candidateId) as { hit: number } | undefined
    return row !== undefined
  }

  // ── 证据 ─────────────────────────────────────────────────────

  /**
   * 记录一步的执行证据。
   *
   * 只存脱敏后的内容——原始输出不离开执行进程。
   */
  addEvidence(input: {
    stepId: string
    source: EvidenceSource
    text?: string | null
    imagePath?: string | null
    exitCode?: number | null
    timedOut?: boolean
    durationMs?: number | null
    redacted?: boolean
  }): Evidence {
    const evidence: Evidence = {
      id: ids.evidence(),
      stepId: input.stepId,
      source: input.source,
      text: input.text ?? null,
      imagePath: input.imagePath ?? null,
      exitCode: input.exitCode ?? null,
      timedOut: input.timedOut ?? false,
      durationMs: input.durationMs ?? null,
      redacted: input.redacted ?? false,
      createdAt: Date.now(),
    }

    this.db
      .prepare(
        `INSERT INTO evidence
         (id, step_id, source, text, image_path, exit_code, timed_out, duration_ms, redacted, created_at)
         VALUES (@id, @stepId, @source, @text, @imagePath, @exitCode, @timedOut, @durationMs, @redacted, @createdAt)`,
      )
      .run({
        ...evidence,
        timedOut: evidence.timedOut ? 1 : 0,
        redacted: evidence.redacted ? 1 : 0,
      })

    return evidence
  }

  getEvidence(id: string): Evidence | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as EvidenceRow | undefined
    return row === undefined ? null : toEvidence(row)
  }

  /** 给截图补上 QB 读到的内容：之后检索坑、诊断时，图里的报错也能被用上。 */
  setEvidenceText(id: string, text: string): void {
    this.db.prepare('UPDATE evidence SET text = ? WHERE id = ?').run(text, id)
  }

  listEvidence(stepId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE step_id = ? ORDER BY created_at')
      .all(stepId) as EvidenceRow[]
    return rows.map(toEvidence)
  }

  /** 一次取回整份 runbook 的证据，省得前端按步骤逐个请求。 */
  evidenceByRunbook(runbookId: string): Record<string, Evidence[]> {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM evidence e
         JOIN steps s ON s.id = e.step_id
         WHERE s.runbook_id = ?
         ORDER BY e.created_at`,
      )
      .all(runbookId) as EvidenceRow[]

    const out: Record<string, Evidence[]> = {}
    for (const row of rows) {
      const ev = toEvidence(row)
      ;(out[ev.stepId] ??= []).push(ev)
    }
    return out
  }

  // ── 知识：环境 / skill / 坑 ──────────────────────────────────

  listEnvironments(): Environment[] {
    const rows = this.db.prepare('SELECT * FROM environments ORDER BY name').all() as EnvRow[]
    return rows.map(toEnvironment)
  }

  upsertEnvironment(input: { name: string; facts: EnvironmentFacts; ownerId?: string }): Environment {
    const existing = this.db.prepare('SELECT * FROM environments WHERE name = ?').get(input.name) as
      | EnvRow
      | undefined

    const now = Date.now()
    if (existing !== undefined) {
      this.db
        .prepare('UPDATE environments SET facts_json = ?, collected_at = ? WHERE id = ?')
        .run(JSON.stringify(input.facts), now, existing.id)
      return { ...toEnvironment(existing), facts: input.facts, collectedAt: now }
    }

    const env: Environment = {
      id: ids.environment(),
      name: input.name,
      facts: input.facts,
      ownerId: input.ownerId ?? null,
      collectedAt: now,
      createdAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO environments (id, name, facts_json, owner_id, collected_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(env.id, env.name, JSON.stringify(env.facts), env.ownerId, env.collectedAt, env.createdAt)
    return env
  }

  listSkills(): Skill[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE archived_at IS NULL ORDER BY name')
      .all() as SkillRow[]
    return rows.map(toSkill)
  }

  createLesson(input: {
    anchorKind: LessonAnchor
    anchorRef?: string | null
    condition?: string | null
    symptom: string
    cause?: string | null
    fixMd: string
    nextTimeMd?: string | null
    authorId: string
    sourceTaskId?: string | null
    scope?: LessonScope
  }): Lesson {
    const lesson: Lesson = {
      id: ids.lesson(),
      anchorKind: input.anchorKind,
      anchorRef: input.anchorRef ?? null,
      condition: input.condition ?? null,
      symptom: input.symptom,
      cause: input.cause ?? null,
      fixMd: input.fixMd,
      nextTimeMd: input.nextTimeMd ?? null,
      authorId: input.authorId,
      sourceTaskId: input.sourceTaskId ?? null,
      // 默认 personal：作者自己立即生效，团队级要负责人确认
      scope: input.scope ?? 'personal',
      confirmedBy: null,
      confirmedAt: null,
      hitCount: 0,
      missCount: 0,
      staleAt: null,
      createdAt: Date.now(),
    }

    this.db
      .prepare(
        `INSERT INTO lessons
         (id, anchor_kind, anchor_ref, condition, symptom, cause, fix_md, next_time_md,
          author_id, source_task_id, scope, created_at)
         VALUES (@id, @anchorKind, @anchorRef, @condition, @symptom, @cause, @fixMd,
                 @nextTimeMd, @authorId, @sourceTaskId, @scope, @createdAt)`,
      )
      .run(lesson)

    return lesson
  }

  /**
   * 检索相关的坑。
   *
   * FTS5 + unicode61 对中文是按字切分，召回偏宽但不会漏——对"别再踩
   * 同一个坑"这个目标，宁可多给模型看几条也不要漏掉关键的那条。
   * 换 embeddings 时只改这个方法。
   */
  searchLessons(query: string, limit = 12): Lesson[] {
    const terms = tokenize(query)
    if (terms.length === 0) return this.recentLessons(limit)

    try {
      const rows = this.db
        .prepare(
          `SELECT l.* FROM lessons_fts f
           JOIN lessons l ON l.rowid = f.rowid
           WHERE lessons_fts MATCH ?
             AND l.stale_at IS NULL
           ORDER BY bm25(lessons_fts), l.hit_count DESC
           LIMIT ?`,
        )
        .all(terms.join(' OR '), limit) as LessonRow[]
      return rows.map(toLesson)
    } catch {
      // FTS 查询语法出错（用户输入里的特殊字符）不该让起草整个失败
      return this.recentLessons(limit)
    }
  }

  private recentLessons(limit: number): Lesson[] {
    const rows = this.db
      .prepare('SELECT * FROM lessons WHERE stale_at IS NULL ORDER BY created_at DESC LIMIT ?')
      .all(limit) as LessonRow[]
    return rows.map(toLesson)
  }

  // ── 事件 ─────────────────────────────────────────────────────

  appendEvent(input: {
    taskId: string
    stepId?: string | null
    actorId?: string | null
    kind: EventKind
    payload?: Record<string, unknown>
  }): Event {
    const event: Event = {
      id: ids.event(),
      taskId: input.taskId,
      stepId: input.stepId ?? null,
      actorId: input.actorId ?? null,
      kind: input.kind,
      payload: input.payload ?? {},
      createdAt: Date.now(),
    }

    this.db
      .prepare(
        `INSERT INTO events (id, task_id, step_id, actor_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.taskId,
        event.stepId,
        event.actorId,
        event.kind,
        JSON.stringify(event.payload),
        event.createdAt,
      )

    return event
  }

  listEvents(taskId: string, limit = 200): Event[] {
    // 按 seq 排序：同一毫秒内写入的多个事件靠它保持插入顺序。
    // 只按时间排会让时间线出现颠倒的因果，复盘时读起来就是错的。
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(taskId, limit) as EventRow[]
    return rows.map(toEvent)
  }

  /** 某一步最近的一次内容编辑，界面悬停"我改的"时显示改前改后。 */
  lastEditOf(stepId: string): Event | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE step_id = ? AND kind = 'edit' ORDER BY seq DESC LIMIT 1")
      .get(stepId) as EventRow | undefined
    return row === undefined ? null : toEvent(row)
  }

  // ── 本机设置：模型档案 ───────────────────────────────────────

  listModelProfiles(): StoredModelProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM model_profiles ORDER BY created_at')
      .all() as ModelProfileRow[]
    return rows.map(toModelProfile)
  }

  getModelProfile(id: string): StoredModelProfile | null {
    const row = this.db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as
      | ModelProfileRow
      | undefined
    return row === undefined ? null : toModelProfile(row)
  }

  /** 新建或整体覆盖一个档案。id 为空时新建。 */
  saveModelProfile(
    input: Omit<StoredModelProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): StoredModelProfile {
    const now = Date.now()
    const existing = input.id !== undefined ? this.getModelProfile(input.id) : null
    const profile: StoredModelProfile = {
      ...input,
      id: existing?.id ?? input.id ?? ids.modelProfile(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    this.db
      .prepare(
        `INSERT INTO model_profiles
         (id, name, preset, wire, base_url, api_key, model, options_json, capabilities_json, created_at, updated_at)
         VALUES (@id, @name, @preset, @wire, @baseUrl, @apiKey, @model, @optionsJson, @capabilitiesJson, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, preset = excluded.preset, wire = excluded.wire,
           base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model,
           options_json = excluded.options_json, capabilities_json = excluded.capabilities_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...profile,
        optionsJson: JSON.stringify(profile.options),
        capabilitiesJson: profile.capabilities == null ? null : JSON.stringify(profile.capabilities),
      })
    return profile
  }

  deleteModelProfile(id: string): void {
    this.db.prepare('DELETE FROM model_profiles WHERE id = ?').run(id)
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row === undefined ? null : (JSON.parse(row.value_json) as T)
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now())
  }

  /** 把一串 store 操作包进单个事务：中途失败整体回滚，不留半套参数/半数改动。 */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** 这个任务上是否已记过同样症状的坑（重复导入时去重用）。 */
  hasLesson(taskId: string, symptom: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM lessons WHERE source_task_id = ? AND symptom = ? LIMIT 1')
      .get(taskId, symptom) as { hit: number } | undefined
    return row !== undefined
  }
}

// ── 输入类型 ───────────────────────────────────────────────────

export interface NewStep {
  kind: StepKind
  title: string
  whyMd?: string | null
  whySource?: string | null
  command?: string | null
  envId?: string | null
  expectation?: Expectation | null
  probe?: ReadinessProbe | null
  timeoutMs?: number | null
  expectedMinutes?: number | null
  /** 覆盖整批的来源。 */
  origin?: StepOrigin
  /** 复制底稿时沿用原步骤的血缘；新建时不填，自动生成。 */
  lineageKey?: string
  sourceRef?: string | null
  children?: NewStep[]
}

interface ModelProfileRow {
  id: string
  name: string
  preset: string
  wire: string
  base_url: string
  api_key: string
  model: string
  options_json: string
  capabilities_json: string | null
  created_at: number
  updated_at: number
}

function toModelProfile(r: ModelProfileRow): StoredModelProfile {
  return {
    id: r.id,
    name: r.name,
    preset: r.preset,
    wire: r.wire,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    model: r.model,
    options: JSON.parse(r.options_json) as Record<string, unknown>,
    capabilities: r.capabilities_json === null ? null : (JSON.parse(r.capabilities_json) as unknown),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ── 行 → 领域对象 ──────────────────────────────────────────────

interface UserRow {
  id: string
  name: string
  display_name: string
  created_at: number
}

interface TaskRow {
  id: string
  title: string
  brief_md: string
  initiator_id: string
  assignee_id: string
  parent_step_id: string | null
  status: string
  expected_minutes: number | null
  due_at: number | null
  definition_of_done: string | null
  created_at: number
  started_at: number | null
  ended_at: number | null
}

interface RunbookRow {
  id: string
  task_id: string
  version: number
  created_by: string
  created_at: number
  assumptions_json: string
  params_json: string | null
  base_runbook_id: string | null
  material_id: string | null
  origin: string | null
  source_skill_id: string | null
  source_skill_version: number | null
}

interface StepRow {
  id: string
  runbook_id: string
  parent_id: string | null
  order_key: string
  kind: string
  title: string
  why_md: string | null
  why_source: string | null
  command: string | null
  env_id: string | null
  expectation_json: string | null
  probe_json: string | null
  timeout_ms: number | null
  expected_minutes: number | null
  status: string
  started_at: number | null
  ended_at: number | null
  actual_ms: number | null
  delegate_task_id: string | null
  rev: number
  lineage_key: string | null
  origin: string
  edited_by: string | null
  source_ref: string | null
  status_note: string | null
}

interface EventRow {
  seq: number
  id: string
  task_id: string
  step_id: string | null
  actor_id: string | null
  kind: string
  payload_json: string
  created_at: number
}

interface EvidenceRow {
  id: string
  step_id: string
  source: string
  text: string | null
  image_path: string | null
  exit_code: number | null
  timed_out: number
  duration_ms: number | null
  redacted: number
  created_at: number
}

function toEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id,
    stepId: r.step_id,
    source: r.source as EvidenceSource,
    text: r.text,
    imagePath: r.image_path,
    exitCode: r.exit_code,
    timedOut: r.timed_out === 1,
    durationMs: r.duration_ms,
    redacted: r.redacted === 1,
    createdAt: r.created_at,
  }
}

interface EnvRow {
  id: string
  name: string
  facts_json: string
  owner_id: string | null
  collected_at: number | null
  created_at: number
}

interface SkillRow {
  id: string
  name: string
  description: string
  applies_when: string | null
  owner_id: string | null
  current_version: number
  created_at: number
}

interface LessonRow {
  id: string
  anchor_kind: string
  anchor_ref: string | null
  condition: string | null
  symptom: string
  cause: string | null
  fix_md: string
  next_time_md: string | null
  author_id: string
  source_task_id: string | null
  scope: string
  confirmed_by: string | null
  confirmed_at: number | null
  hit_count: number
  miss_count: number
  stale_at: number | null
  created_at: number
}

function toEnvironment(r: EnvRow): Environment {
  return {
    id: r.id,
    name: r.name,
    facts: JSON.parse(r.facts_json) as EnvironmentFacts,
    ownerId: r.owner_id,
    collectedAt: r.collected_at,
    createdAt: r.created_at,
  }
}

function toSkill(r: SkillRow): Skill {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    appliesWhen: r.applies_when,
    ownerId: r.owner_id,
    currentVersion: r.current_version,
    createdAt: r.created_at,
  }
}

function toLesson(r: LessonRow): Lesson {
  return {
    id: r.id,
    anchorKind: r.anchor_kind as LessonAnchor,
    anchorRef: r.anchor_ref,
    condition: r.condition,
    symptom: r.symptom,
    cause: r.cause,
    fixMd: r.fix_md,
    nextTimeMd: r.next_time_md,
    authorId: r.author_id,
    sourceTaskId: r.source_task_id,
    scope: r.scope as LessonScope,
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    hitCount: r.hit_count,
    missCount: r.miss_count,
    staleAt: r.stale_at,
    createdAt: r.created_at,
  }
}

function toUser(r: UserRow): User {
  return { id: r.id, name: r.name, displayName: r.display_name, createdAt: r.created_at }
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    briefMd: r.brief_md,
    initiatorId: r.initiator_id,
    assigneeId: r.assignee_id,
    parentStepId: r.parent_step_id,
    status: r.status as TaskStatus,
    expectedMinutes: r.expected_minutes,
    dueAt: r.due_at,
    definitionOfDone: r.definition_of_done,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }
}

function toRunbook(r: RunbookRow): Runbook {
  return {
    id: r.id,
    taskId: r.task_id,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    assumptions: JSON.parse(r.assumptions_json) as Assumption[],
    params: r.params_json === null || r.params_json === '' ? [] : (JSON.parse(r.params_json) as Param[]),
    baseRunbookId: r.base_runbook_id,
    materialId: r.material_id,
    origin: (r.origin as Runbook['origin']) ?? null,
    sourceSkillId: r.source_skill_id,
    sourceSkillVersion: r.source_skill_version,
  }
}

function toStep(r: StepRow): Step {
  return {
    id: r.id,
    runbookId: r.runbook_id,
    parentId: r.parent_id,
    orderKey: r.order_key,
    kind: r.kind as StepKind,
    title: r.title,
    whyMd: r.why_md,
    whySource: r.why_source,
    command: r.command,
    envId: r.env_id,
    expectation: r.expectation_json === null ? null : (JSON.parse(r.expectation_json) as Expectation),
    probe: r.probe_json === null ? null : (JSON.parse(r.probe_json) as ReadinessProbe),
    timeoutMs: r.timeout_ms,
    expectedMinutes: r.expected_minutes,
    status: r.status as StepStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    actualMs: r.actual_ms,
    delegateTaskId: r.delegate_task_id,
    rev: r.rev,
    lineageKey: r.lineage_key,
    origin: r.origin as StepOrigin,
    editedBy: r.edited_by,
    sourceRef: r.source_ref,
    statusNote: r.status_note,
  }
}

function toEvent(r: EventRow): Event {
  return {
    id: r.id,
    taskId: r.task_id,
    stepId: r.step_id,
    actorId: r.actor_id,
    kind: r.kind as EventKind,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at,
  }
}
