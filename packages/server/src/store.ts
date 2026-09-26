import {
  ids,
  orderKeyBetween,
  type Assumption,
  type Event,
  type EventKind,
  type Expectation,
  type ReadinessProbe,
  type Runbook,
  type Step,
  type StepKind,
  type StepStatus,
  type Task,
  type TaskStatus,
  type User,
} from '@qb/core'
import type { Db } from './db.ts'

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
    sourceSkillId?: string | null
    sourceSkillVersion?: number | null
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
        sourceSkillId: input.sourceSkillId ?? null,
        sourceSkillVersion: input.sourceSkillVersion ?? null,
      }

      this.db
        .prepare(
          `INSERT INTO runbooks
           (id, task_id, version, created_by, created_at, assumptions_json,
            source_skill_id, source_skill_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runbook.id,
          runbook.taskId,
          runbook.version,
          runbook.createdBy,
          runbook.createdAt,
          JSON.stringify(runbook.assumptions),
          runbook.sourceSkillId,
          runbook.sourceSkillVersion,
        )

      const steps = this.insertStepTree(runbook.id, null, input.steps)
      return { runbook, steps }
    })

    return run()
  }

  /** 递归写入步骤树，自动生成 orderKey。 */
  private insertStepTree(runbookId: string, parentId: string | null, nodes: NewStep[]): Step[] {
    const out: Step[] = []
    let prevKey: string | null = null

    const stmt = this.db.prepare(
      `INSERT INTO steps
       (id, runbook_id, parent_id, order_key, kind, title, why_md, why_source,
        command, env_id, expectation_json, probe_json, timeout_ms, expected_minutes, status)
       VALUES (@id, @runbookId, @parentId, @orderKey, @kind, @title, @whyMd, @whySource,
               @command, @envId, @expectationJson, @probeJson, @timeoutMs, @expectedMinutes, @status)`,
    )

    for (const node of nodes) {
      const orderKey = orderKeyBetween(prevKey, null)
      prevKey = orderKey

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
      }

      stmt.run({
        ...step,
        expectationJson: step.expectation === null ? null : JSON.stringify(step.expectation),
        probeJson: step.probe === null ? null : JSON.stringify(step.probe),
      })

      out.push(step)
      if (node.children !== undefined && node.children.length > 0) {
        out.push(...this.insertStepTree(runbookId, step.id, node.children))
      }
    }

    return out
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
           WHERE s.runbook_id = ? AND s.parent_id IS NULL
           UNION ALL
           SELECT s.*, t.path || char(31) || s.order_key, t.depth + 1
           FROM steps s JOIN tree t ON s.parent_id = t.id
         )
         SELECT * FROM tree ORDER BY path`,
      )
      .all(runbookId) as StepRow[]
    return rows.map(toStep)
  }

  getStep(id: string): Step | null {
    const row = this.db.prepare('SELECT * FROM steps WHERE id = ?').get(id) as StepRow | undefined
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
    extra: { startedAt?: number; endedAt?: number; actualMs?: number } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE steps SET status = ?,
           started_at = COALESCE(?, started_at),
           ended_at   = COALESCE(?, ended_at),
           actual_ms  = COALESCE(?, actual_ms)
         WHERE id = ?`,
      )
      .run(status, extra.startedAt ?? null, extra.endedAt ?? null, extra.actualMs ?? null, stepId)
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
  children?: NewStep[]
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
