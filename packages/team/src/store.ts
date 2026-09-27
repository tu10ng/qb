/**
 * 团队服务的读写。
 *
 * 引擎是任务数据的唯一写者（镜像只收快照）；告警的 open→ack→resolved、
 * 评论与求助回答是团队侧的写。所有跨行写入走事务。
 */

import { createHash, randomBytes } from 'node:crypto'
import { customAlphabet } from 'nanoid'
import type { Db } from './db.ts'

const newId = (prefix: string) => `${prefix}_${customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 12)()}`

export interface TeamUser {
  id: string
  name: string
  displayName: string
}

export interface TaskMirror {
  id: string
  title: string
  briefMd: string
  initiatorName: string
  assigneeName: string
  status: string
  expectedMinutes: number | null
  startedAt: number | null
  endedAt: number | null
  runbookVersion: number | null
  updatedAt: number
}

export interface StepMirror {
  taskId: string
  id: string
  parentId: string | null
  orderKey: string
  kind: string
  title: string
  command: string | null
  status: string
  expectedMinutes: number | null
  actualMs: number | null
  statusNote: string | null
}

export interface EventMirror {
  taskId: string
  engineSeq: number
  stepId: string | null
  actorName: string | null
  kind: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface AlertRow {
  key: string
  taskId: string
  stepId: string | null
  level: 'red' | 'yellow'
  type: string
  message: string
  count: number
  status: 'open' | 'ack' | 'resolved'
  ackedBy: string | null
  ackedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CommentRow {
  id: string
  taskId: string
  stepId: string | null
  authorId: string | null
  authorName: string
  body: string
  createdAt: number
  downSeq: number
}

export interface QuestionRow {
  id: string
  taskId: string
  stepId: string | null
  askerName: string
  body: string
  answer: string | null
  answeredByName: string | null
  answeredAt: number | null
  createdAt: number
  downSeq: number
}

export interface PushChannel {
  id: string
  name: string
  kind: 'webhook' | 'command'
  config: Record<string, unknown>
  minLevel: 'red' | 'yellow'
  enabled: boolean
}

export interface DownItem {
  kind: 'comment' | 'answer' | 'ack'
  payload: unknown
}

/** 一次引擎推送的全部内容。 */
export interface SyncPush {
  user: { name: string; displayName: string }
  sinceDownSeq: number
  tasks: Array<TaskMirror & { steps?: StepMirror[] }>
  events: EventMirror[]
  /** 这些任务当前的告警决策集（全量）：不在集合里的现存 open 告警解除。 */
  alerts: Array<{ key: string; taskId: string; stepId: string | null; level: 'red' | 'yellow'; type: string; message: string; at: number }>
  questions: Array<{ id: string; taskId: string; stepId: string | null; body: string; createdAt: number }>
}

export interface SyncResult {
  /** 新出现的红告警（供推送用）。 */
  newRedAlerts: AlertRow[]
  resolvedAlerts: AlertRow[]
  down: DownItem[]
  lastDownSeq: number
}

export class TeamStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // ── 用户 / 令牌 / 邀请 ───────────────────────────────────

  createUser(name: string, displayName?: string): TeamUser {
    const u: TeamUser = { id: newId('usr'), name, displayName: displayName ?? name }
    this.db
      .prepare('INSERT INTO users (id, name, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run(u.id, u.name, u.displayName, Date.now())
    return u
  }

  userByName(name: string): TeamUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as
      | { id: string; name: string; display_name: string }
      | undefined
    return row === undefined ? null : { id: row.id, name: row.name, displayName: row.display_name }
  }

  userById(id: string): TeamUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: string; name: string; display_name: string }
      | undefined
    return row === undefined ? null : { id: row.id, name: row.name, displayName: row.display_name }
  }

  hasUsers(): boolean {
    return (this.db.prepare('SELECT count(*) c FROM users').get() as { c: number }).c > 0
  }

  /** 发令牌：明文只在这里出现一次，库里只存哈希。 */
  issueToken(userId: string): string {
    const token = randomBytes(24).toString('base64url')
    this.db
      .prepare('INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now())
    return token
  }

  /** 校验令牌，返回用户；顺手记录使用时间。 */
  userByToken(token: string): TeamUser | null {
    const row = this.db
      .prepare('SELECT t.user_id uid, u.name, u.display_name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
      .get(hashToken(token)) as { uid: string; name: string; display_name: string } | undefined
    if (row === undefined) return null
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), hashToken(token))
    return { id: row.uid, name: row.name, displayName: row.display_name }
  }

  createInvite(expiresInMs: number, maxUses = 1, createdBy: string | null = null): string {
    const token = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 16)()
    this.db
      .prepare('INSERT INTO invites (token, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, createdBy, maxUses, Date.now() + expiresInMs, Date.now())
    return token
  }

  /** 用掉一张邀请（过期/用尽抛错）。 */
  consumeInvite(token: string): void {
    const row = this.db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as
      | { uses: number; max_uses: number; expires_at: number }
      | undefined
    if (row === undefined) throw new Error('邀请码不存在')
    if (row.expires_at < Date.now()) throw new Error('邀请码已过期')
    if (row.uses >= row.max_uses) throw new Error('邀请码已被使用')
    this.db.prepare('UPDATE invites SET uses = uses + 1 WHERE token = ?').run(token)
  }

  // ── 引擎同步（镜像写入 + 下行回流）────────────────────────

  ingestPush(push: SyncPush): SyncResult {
    const tx = this.db.transaction((): SyncResult => {
      // 用户：引擎报上来的名字（执行者/发起人）按名 upsert
      for (const person of [push.user, ...push.tasks.flatMap((t) => [{ name: t.initiatorName, displayName: t.initiatorName }, { name: t.assigneeName, displayName: t.assigneeName }])]) {
        if (person.name !== '' && this.userByName(person.name) === null) {
          this.createUser(person.name, person.displayName)
        }
      }

      for (const t of push.tasks) {
        this.db
          .prepare(
            `INSERT INTO tasks (id, title, brief_md, initiator_name, assignee_name, status, expected_minutes,
                                started_at, ended_at, runbook_version, updated_at)
             VALUES (@id, @title, @briefMd, @initiatorName, @assigneeName, @status, @expectedMinutes,
                     @startedAt, @endedAt, @runbookVersion, @updatedAt)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, brief_md = excluded.brief_md,
               initiator_name = excluded.initiator_name, assignee_name = excluded.assignee_name,
               status = excluded.status, expected_minutes = excluded.expected_minutes,
               started_at = excluded.started_at, ended_at = excluded.ended_at,
               runbook_version = excluded.runbook_version, updated_at = excluded.updated_at`,
          )
          .run({ ...t, updatedAt: Date.now() })

        if (t.steps !== undefined) {
          const del = this.db.prepare('DELETE FROM steps WHERE task_id = ?')
          const ins = this.db.prepare(
            `INSERT INTO steps (task_id, id, parent_id, order_key, kind, title, command, status,
                                expected_minutes, actual_ms, status_note, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          del.run(t.id)
          for (const s of t.steps) {
            ins.run(s.taskId, s.id, s.parentId, s.orderKey, s.kind, s.title, s.command, s.status, s.expectedMinutes, s.actualMs, s.statusNote, Date.now())
          }
        }
      }

      // 事件：幂等（task_id + engine_seq 唯一）
      const insEvent = this.db.prepare(
        `INSERT OR IGNORE INTO events (task_id, engine_seq, step_id, actor_name, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const e of push.events) {
        insEvent.run(e.taskId, e.engineSeq, e.stepId, e.actorName, e.kind, JSON.stringify(e.payload), e.createdAt)
      }

      // 求助：幂等（按 id）
      const insQ = this.db.prepare(
        `INSERT OR IGNORE INTO questions (id, task_id, step_id, asker_name, body, created_at, down_seq)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      for (const q of push.questions) {
        insQ.run(q.id, q.taskId, q.stepId, push.user.name, q.body, q.createdAt)
      }

      // 告警：决策集合并。同 key 存在则更新（count 不减）；这些任务里
      // 不在决策集的 open 告警 → resolved；ack 过的不动。
      const newRed: AlertRow[] = []
      const resolved: AlertRow[] = []
      const seenKeys = new Set(push.alerts.map((a) => a.key))
      // 解除扫描范围：这批快照里的任务 + 决策集里的任务（快照任务即使
      // 决策集为空也要扫——"条件消失"本身就是空决策集）
      const taskIds = new Set<string>([...push.tasks.map((t) => t.id), ...push.alerts.map((a) => a.taskId)])

      for (const a of push.alerts) {
        const existing = this.alertByKey(a.key)
        if (existing === undefined) {
          const now = Date.now()
          this.db
            .prepare(
              `INSERT INTO alerts (key, task_id, step_id, level, type, message, count, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)`,
            )
            .run(a.key, a.taskId, a.stepId, a.level, a.type, a.message, now, now)
          if (a.level === 'red') newRed.push(this.alertByKey(a.key)!)
        } else {
          this.db
            .prepare('UPDATE alerts SET message = ?, level = ?, updated_at = ? WHERE key = ?')
            .run(a.message, a.level, Date.now(), a.key)
          // 解除过的又复发：重新打开，通知再来一次
          if (existing.status === 'resolved') {
            this.db.prepare(`UPDATE alerts SET status = 'open', acked_by = NULL, acked_at = NULL WHERE key = ?`).run(a.key)
            if (a.level === 'red') newRed.push(this.alertByKey(a.key)!)
          }
        }
      }

      for (const taskId of taskIds) {
        const open = this.db.prepare("SELECT key FROM alerts WHERE task_id = ? AND status != 'resolved'").all(taskId) as Array<{ key: string }>
        for (const row of open) {
          if (!seenKeys.has(row.key)) {
            this.db.prepare("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE key = ?").run(Date.now(), row.key)
            resolved.push(this.alertByKey(row.key)!)
          }
        }
      }

      const down = this.pullDown(push.sinceDownSeq)
      return { newRedAlerts: newRed, resolvedAlerts: resolved, ...down }
    })
    return tx()
  }

  /** 下行项（评论 / 回答 / 已读确认），带序号供引擎做游标。 */
  private pullDown(since: number): { down: DownItem[]; lastDownSeq: number } {
    const max = (this.db.prepare('SELECT seq FROM down_seq WHERE id = 1').get() as { seq: number }).seq
    const down: DownItem[] = []

    const comments = this.db
      .prepare('SELECT * FROM comments WHERE down_seq > ? AND down_seq <= ? ORDER BY down_seq')
      .all(since, max) as Array<Record<string, unknown>>
    for (const c of comments) down.push({ kind: 'comment', payload: c })

    const questions = this.db
      .prepare('SELECT * FROM questions WHERE down_seq > ? AND down_seq <= ? AND answer IS NOT NULL ORDER BY down_seq')
      .all(since, max) as Array<Record<string, unknown>>
    for (const q of questions) down.push({ kind: 'answer', payload: q })

    const acks = this.db
      .prepare('SELECT key, task_id, acked_by, acked_at FROM alerts WHERE down_seq IS NOT NULL AND down_seq > ? AND down_seq <= ? ORDER BY down_seq')
      .all(since, max) as Array<Record<string, unknown>>
    for (const a of acks) down.push({ kind: 'ack', payload: a })

    return { down, lastDownSeq: max }
  }

  private nextDownSeq(): number {
    this.db.prepare('UPDATE down_seq SET seq = seq + 1 WHERE id = 1').run()
    return (this.db.prepare('SELECT seq FROM down_seq WHERE id = 1').get() as { seq: number }).seq
  }

  // ── 团队侧写入（评论 / 回答 / 已读）──────────────────────

  addComment(taskId: string, author: TeamUser, body: string, stepId: string | null = null): CommentRow {
    const row: CommentRow = {
      id: newId('cmt'),
      taskId,
      stepId,
      authorId: author.id,
      authorName: author.displayName,
      body,
      createdAt: Date.now(),
      downSeq: this.nextDownSeq(),
    }
    this.db
      .prepare('INSERT INTO comments (id, task_id, step_id, author_id, author_name, body, created_at, down_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.taskId, row.stepId, row.authorId, row.authorName, row.body, row.createdAt, row.downSeq)
    return row
  }

  /** 回答求助：写答案并打上下行序号（引擎按它增量拉取）。 */
  answerQuestion(questionId: string, answer: string, by: TeamUser): QuestionRow {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as
      | { id: string; answered: undefined }
      | undefined
    if (row === undefined) throw new Error('求助不存在')
    const downSeq = this.nextDownSeq()
    this.db
      .prepare('UPDATE questions SET answer = ?, answered_by_name = ?, answered_at = ?, down_seq = ? WHERE id = ?')
      .run(answer, by.displayName, Date.now(), downSeq, questionId)
    return this.questionById(questionId)!
  }

  questionById(id: string): QuestionRow | null {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? null : toQuestion(r)
  }

  ackAlert(key: string, by: TeamUser): AlertRow {
    this.db.prepare("UPDATE alerts SET status = 'ack', acked_by = ?, acked_at = ?, down_seq = ?, updated_at = ? WHERE key = ?").run(by.id, Date.now(), this.nextDownSeq(), Date.now(), key)
    const row = this.alertByKey(key)
    if (row === undefined) throw new Error('告警不存在')
    return row
  }

  // ── 读 ───────────────────────────────────────────────────

  alertByKey(key: string): AlertRow | undefined {
    const r = this.db.prepare('SELECT * FROM alerts WHERE key = ?').get(key) as Record<string, unknown> | undefined
    return r === undefined ? undefined : toAlert(r)
  }

  listTasks(scope: 'initiated' | 'assigned' | 'related', userName: string): Array<TaskMirror & { total: number; done: number; worstAlert: 'red' | 'yellow' | null }> {
    // related：我发起的 + 派给我的 + 有我未回答求助的 + 我评论/已读过的。
    // 本地自建任务的"发起人"就是执行者本人，发起人视角若只按 initiator
    // 匹配会什么都看不到——他真正相关的是"向我求助/我介入过"的任务。
    const where =
      scope === 'initiated'
        ? 'initiator_name = @me'
        : scope === 'assigned'
          ? 'assignee_name = @me'
          : `initiator_name = @me OR assignee_name = @me
             OR id IN (SELECT task_id FROM questions WHERE answer IS NULL AND asker_name != @me)
             OR id IN (SELECT task_id FROM comments c JOIN users u ON u.id = c.author_id WHERE u.name = @me)
             OR id IN (SELECT task_id FROM alerts a JOIN users u ON u.id = a.acked_by WHERE u.name = @me)`
    const rows = this.db
      .prepare(`SELECT DISTINCT t.* FROM tasks t WHERE ${where.replace(/id/g, 't.id')} ORDER BY t.updated_at DESC`)
      .all({ me: userName }) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const id = r.id as string
      const counts = this.db
        .prepare("SELECT count(*) total, sum(CASE WHEN status IN ('ok','skipped') THEN 1 ELSE 0 END) done FROM steps WHERE task_id = ? AND kind != 'note'")
        .get(id) as { total: number; done: number | null }
      const alert = this.db
        .prepare("SELECT level FROM alerts WHERE task_id = ? AND status = 'open' ORDER BY CASE level WHEN 'red' THEN 0 ELSE 1 END LIMIT 1")
        .get(id) as { level: 'red' | 'yellow' } | undefined
      return { ...toTask(r), total: counts.total, done: counts.done ?? 0, worstAlert: alert?.level ?? null }
    })
  }

  taskById(id: string): TaskMirror | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? null : toTask(r)
  }

  stepsOf(taskId: string): StepMirror[] {
    return (this.db
      .prepare(
        `WITH RECURSIVE tree AS (
           SELECT s.*, s.order_key AS path FROM steps s WHERE s.task_id = ? AND s.parent_id IS NULL
           UNION ALL
           SELECT s.*, t.path || char(31) || s.order_key FROM steps s JOIN tree t ON s.parent_id = t.id WHERE s.task_id = ?
         )
         SELECT * FROM tree ORDER BY path`,
      )
      .all(taskId, taskId) as Array<Record<string, unknown>>).map(toStep)
  }

  eventsOf(taskId: string, limit = 50): EventMirror[] {
    return (this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>).map((r) => ({
      taskId: r.task_id as string,
      engineSeq: r.engine_seq as number,
      stepId: (r.step_id as string | null) ?? null,
      actorName: (r.actor_name as string | null) ?? null,
      kind: r.kind as string,
      payload: JSON.parse(r.payload_json as string) as Record<string, unknown>,
      createdAt: r.created_at as number,
    }))
  }

  commentsOf(taskId: string): CommentRow[] {
    return (this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<Record<string, unknown>>).map(toComment)
  }

  questionsOf(taskId: string): QuestionRow[] {
    return (this.db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<Record<string, unknown>>).map(toQuestion)
  }

  alertsOf(taskId: string, includeResolved = false): AlertRow[] {
    const rows = this.db
      .prepare(includeResolved ? 'SELECT * FROM alerts WHERE task_id = ? ORDER BY created_at DESC' : "SELECT * FROM alerts WHERE task_id = ? AND status != 'resolved' ORDER BY created_at DESC")
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map(toAlert)
  }

  openAlertsForUser(userName: string): AlertRow[] {
    return (this.db
      .prepare(
        `SELECT a.* FROM alerts a JOIN tasks t ON t.id = a.task_id
         WHERE t.initiator_name = ? AND a.status = 'open' AND a.level = 'red'
         ORDER BY a.updated_at DESC`,
      )
      .all(userName) as Array<Record<string, unknown>>).map(toAlert)
  }

  // ── 推送渠道与设置 ───────────────────────────────────────

  listChannels(): PushChannel[] {
    return (this.db.prepare('SELECT * FROM push_channels ORDER BY created_at').all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as PushChannel['kind'],
      config: JSON.parse(r.config_json as string) as Record<string, unknown>,
      minLevel: r.min_level as PushChannel['minLevel'],
      enabled: (r.enabled as number) === 1,
    }))
  }

  saveChannel(input: Omit<PushChannel, 'id'> & { id?: string }): PushChannel {
    const id = input.id ?? newId('pch')
    this.db
      .prepare(
        `INSERT INTO push_channels (id, name, kind, config_json, min_level, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
           config_json = excluded.config_json, min_level = excluded.min_level, enabled = excluded.enabled`,
      )
      .run(id, input.name, input.kind, JSON.stringify(input.config), input.minLevel, input.enabled ? 1 : 0, Date.now())
    return this.listChannels().find((c) => c.id === id)!
  }

  deleteChannel(id: string): void {
    this.db.prepare('DELETE FROM push_channels WHERE id = ?').run(id)
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
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
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ── 行 → 领域对象 ─────────────────────────────────────────

function toTask(r: Record<string, unknown>): TaskMirror {
  return {
    id: r.id as string,
    title: r.title as string,
    briefMd: r.brief_md as string,
    initiatorName: r.initiator_name as string,
    assigneeName: r.assignee_name as string,
    status: r.status as string,
    expectedMinutes: (r.expected_minutes as number | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    endedAt: (r.ended_at as number | null) ?? null,
    runbookVersion: (r.runbook_version as number | null) ?? null,
    updatedAt: r.updated_at as number,
  }
}

function toStep(r: Record<string, unknown>): StepMirror {
  return {
    taskId: r.task_id as string,
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    orderKey: r.order_key as string,
    kind: r.kind as string,
    title: r.title as string,
    command: (r.command as string | null) ?? null,
    status: r.status as string,
    expectedMinutes: (r.expected_minutes as number | null) ?? null,
    actualMs: (r.actual_ms as number | null) ?? null,
    statusNote: (r.status_note as string | null) ?? null,
  }
}

function toAlert(r: Record<string, unknown>): AlertRow {
  return {
    key: r.key as string,
    taskId: r.task_id as string,
    stepId: (r.step_id as string | null) ?? null,
    level: r.level as AlertRow['level'],
    type: r.type as string,
    message: r.message as string,
    count: r.count as number,
    status: r.status as AlertRow['status'],
    ackedBy: (r.acked_by as string | null) ?? null,
    ackedAt: (r.acked_at as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }
}

function toComment(r: Record<string, unknown>): CommentRow {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    stepId: (r.step_id as string | null) ?? null,
    authorId: (r.author_id as string | null) ?? null,
    authorName: r.author_name as string,
    body: r.body as string,
    createdAt: r.created_at as number,
    downSeq: r.down_seq as number,
  }
}

function toQuestion(r: Record<string, unknown>): QuestionRow {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    stepId: (r.step_id as string | null) ?? null,
    askerName: r.asker_name as string,
    body: r.body as string,
    answer: (r.answer as string | null) ?? null,
    answeredByName: (r.answered_by_name as string | null) ?? null,
    answeredAt: (r.answered_at as number | null) ?? null,
    createdAt: r.created_at as number,
    downSeq: r.down_seq as number,
  }
}
