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

interface UserRowT {
  id: string
  name: string
  display_name: string
  is_admin: number
}

function toTeamUser(r: UserRowT): TeamUser {
  return { id: r.id, name: r.name, displayName: r.display_name, isAdmin: r.is_admin === 1 }
}

export interface TeamUser {
  id: string
  name: string
  displayName: string
  /** 首位注册用户即管理员：渠道与邀请只有他能配（命令渠道等于 shell）。 */
  isAdmin: boolean
}

export interface TaskMirror {
  id: string
  title: string
  briefMd: string
  initiatorName: string
  assigneeName: string
  status: string
  /** 委派产生的子任务：指向父步骤（引擎的 step id）。 */
  parentStepId: string | null
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
  /** 步骤血缘：坑与底稿提议都按它路由。 */
  lineageKey?: string | null
  /** 执行者开了"共享输出"的步骤带最新输出（脱敏+截尾）。 */
  lastOutput?: string | null
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

export interface LessonMirror {
  id: string
  lineageKey: string | null
  symptom: string
  cause: string | null
  fixMd: string
  condition: string | null
  authorName: string
  taskId: string | null
  taskTitle: string | null
  status: 'unverified' | 'confirmed' | 'declined'
  confirmedBy: string | null
  confirmedAt: number | null
  createdAt: number
}

export interface BaseProposalRow {
  id: string
  lineageKey: string
  stepTitle: string
  beforeMd: string
  afterMd: string
  fromName: string
  fromTaskId: string | null
  fromTaskTitle: string | null
  status: 'pending' | 'accepted' | 'declined' | 'conflict'
  decidedBy: string | null
  decidedAt: number | null
  createdAt: number
}

export interface DownItem {
  kind: 'comment' | 'answer' | 'ack' | 'task' | 'task_progress' | 'lesson' | 'lesson_status' | 'proposal' | 'proposal_status'
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
  /** 待共享的坑（M9）：作者已确认共享，脱敏后整条上传。 */
  lessons: Array<{
    id: string
    lineageKey: string | null
    symptom: string
    cause: string | null
    fixMd: string
    condition: string | null
    taskId: string | null
    taskTitle: string | null
    createdAt: number
  }>
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
    const first = !this.hasUsers()
    const u: TeamUser = { id: newId('usr'), name, displayName: displayName ?? name, isAdmin: first }
    this.db
      .prepare('INSERT INTO users (id, name, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, u.name, u.displayName, first ? 1 : 0, Date.now())
    return u
  }

  userByName(name: string): TeamUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRowT | undefined
    return row === undefined ? null : toTeamUser(row)
  }

  userById(id: string): TeamUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRowT | undefined
    return row === undefined ? null : toTeamUser(row)
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
      .prepare('SELECT t.user_id uid, u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
      .get(hashToken(token)) as (UserRowT & { uid: string }) | undefined
    if (row === undefined) return null
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), hashToken(token))
    return { id: row.uid, name: row.name, displayName: row.display_name, isAdmin: row.is_admin === 1 }
  }

  createInvite(expiresInMs: number, maxUses = 1, createdBy: string | null = null): string {
    const token = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 16)()
    this.db
      .prepare('INSERT INTO invites (token, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, createdBy, maxUses, Date.now() + expiresInMs, Date.now())
    return token
  }

  /** 用掉一张邀请（过期/用尽抛错）。原子：条件 UPDATE，并发不会超额。 */
  consumeInvite(token: string): void {
    const r = this.db
      .prepare('UPDATE invites SET uses = uses + 1 WHERE token = ? AND expires_at > ? AND uses < max_uses')
      .run(token, Date.now())
    if (r.changes === 0) {
      const row = this.db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as
        | { uses: number; max_uses: number; expires_at: number }
        | undefined
      throw new Error(row === undefined ? '邀请码不存在' : row.expires_at <= Date.now() ? '邀请码已过期' : '邀请码已被使用')
    }
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
        // parent_step_id：快照带了就用；老引擎不带时从派活记录补（委派产生的
        // 子任务在 dispatched_tasks 里记着父步骤）。原先这列从没写进去过，
        // 委派进度因此一条都没生成。
        this.db
          .prepare(
            `INSERT INTO tasks (id, title, brief_md, initiator_name, assignee_name, status, parent_step_id,
                                expected_minutes, started_at, ended_at, runbook_version, updated_at)
             VALUES (@id, @title, @briefMd, @initiatorName, @assigneeName, @status,
                     COALESCE(@parentStepId, (SELECT parent_step_id FROM dispatched_tasks WHERE id = @id)),
                     @expectedMinutes, @startedAt, @endedAt, @runbookVersion, @updatedAt)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, brief_md = excluded.brief_md,
               initiator_name = excluded.initiator_name, assignee_name = excluded.assignee_name,
               status = excluded.status,
               parent_step_id = COALESCE(excluded.parent_step_id, tasks.parent_step_id),
               expected_minutes = excluded.expected_minutes,
               started_at = excluded.started_at, ended_at = excluded.ended_at,
               runbook_version = excluded.runbook_version, updated_at = excluded.updated_at`,
          )
          .run({ ...t, parentStepId: t.parentStepId ?? null, updatedAt: Date.now() })

        if (t.steps !== undefined) {
          const del = this.db.prepare('DELETE FROM steps WHERE task_id = ?')
          const ins = this.db.prepare(
            `INSERT INTO steps (task_id, id, parent_id, order_key, kind, title, command, status,
                                expected_minutes, actual_ms, status_note, lineage_key, last_output, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          del.run(t.id)
          for (const s of t.steps) {
            ins.run(s.taskId, s.id, s.parentId, s.orderKey, s.kind, s.title, s.command, s.status, s.expectedMinutes, s.actualMs, s.statusNote, s.lineageKey ?? null, s.lastOutput ?? null, Date.now())
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

      // 坑（M9）：按 id 幂等；新到的排下行序号，并给用同血缘任务的发起人
      // 挂 🟡"新坑待确认"。作者自己不会被提醒。
      for (const l of push.lessons) {
        if (this.lessonById(l.id) !== null) continue
        this.db
          .prepare(
            `INSERT INTO lessons (id, lineage_key, symptom, cause, fix_md, condition,
                                  author_name, task_id, task_title, status, created_at, down_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)`,
          )
          .run(l.id, l.lineageKey, l.symptom, l.cause, l.fixMd, l.condition,
               push.user.name, l.taskId, l.taskTitle, l.createdAt, this.nextDownSeq())
        if (l.lineageKey !== null) {
          const rows = this.db
            .prepare(
              `SELECT DISTINCT t.id, t.initiator_name FROM tasks t
               JOIN steps s ON s.task_id = t.id
               WHERE s.lineage_key = ? AND t.initiator_name != ? AND t.initiator_name != ''`,
            )
            .all(l.lineageKey, push.user.name) as Array<{ id: string; initiator_name: string }>
          const now = Date.now()
          for (const r of rows) {
            this.db
              .prepare(
                `INSERT OR REPLACE INTO alerts (key, task_id, level, type, message, count, status, created_at, updated_at)
                 VALUES (?, ?, 'yellow', 'lesson_pending', ?, 1, 'open', ?, ?)`,
              )
              .run(`lesson:${l.id}:${r.id}`, r.id, `新坑待确认：${l.symptom.slice(0, 60)}（${push.user.displayName} 记的）`, now, now)
          }
        }
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
        // 只解除引擎决策集里的告警；lesson: 前缀是团队侧生命周期的坑待确认
        // 告警，由 confirmLesson 解除——引擎决策集里永远不会有它
        const open = this.db
          .prepare("SELECT key FROM alerts WHERE task_id = ? AND status != 'resolved' AND key NOT LIKE 'lesson:%'")
          .all(taskId) as Array<{ key: string }>
        for (const row of open) {
          if (!seenKeys.has(row.key)) {
            this.db.prepare("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE key = ?").run(Date.now(), row.key)
            resolved.push(this.alertByKey(row.key)!)
          }
        }
      }

      // 委派进度：子任务（有 parent_step_id）有变化时，给委派者一条下行——
      // 他那一步的委派行显示对方进度，对方完成时那一步自动完成。
      // 每个子任务只留一行，状态/进度/最坏告警有变才换新的下行序号。
      for (const t of push.tasks) this.refreshDelegationProgress(t.id)

      const down = this.pullDown(push.sinceDownSeq, push.user.name)
      return { newRedAlerts: newRed, resolvedAlerts: resolved, ...down }
    })
    return tx()
  }

  /** 下行项（评论 / 回答 / 已读确认），带序号供引擎做游标。 */
  /**
   * 下行项（评论 / 回答 / 已读 / 派来的任务 / 委派进度），按执行者过滤。
   *
   * 每台引擎只收自己任务上的东西——不按用户过滤的话，多引擎会互相
   * 收到别人的评论，落到不存在的任务上直接外键崩。
   */
  private pullDown(since: number, userName: string): { down: DownItem[]; lastDownSeq: number } {
    const max = (this.db.prepare('SELECT seq FROM down_seq WHERE id = 1').get() as { seq: number }).seq
    const down: DownItem[] = []

    const dispatched = this.db
      .prepare('SELECT * FROM dispatched_tasks WHERE assignee_name = ? AND down_seq > ? AND down_seq <= ? ORDER BY down_seq')
      .all(userName, since, max) as Array<Record<string, unknown>>
    for (const t of dispatched) down.push({ kind: 'task', payload: t })

    const comments = this.db
      .prepare(
        `SELECT c.* FROM comments c JOIN tasks t ON t.id = c.task_id
         WHERE t.assignee_name = ? AND c.down_seq > ? AND c.down_seq <= ? ORDER BY c.down_seq`,
      )
      .all(userName, since, max) as Array<Record<string, unknown>>
    for (const c of comments) down.push({ kind: 'comment', payload: c })

    const questions = this.db
      .prepare(
        `SELECT q.* FROM questions q JOIN tasks t ON t.id = q.task_id
         WHERE q.asker_name = ? AND q.down_seq > ? AND q.down_seq <= ? AND q.answer IS NOT NULL ORDER BY q.down_seq`,
      )
      .all(userName, since, max) as Array<Record<string, unknown>>
    for (const q of questions) down.push({ kind: 'answer', payload: q })

    const acks = this.db
      .prepare(
        `SELECT a.key, a.task_id, a.acked_by, a.acked_at FROM alerts a JOIN tasks t ON t.id = a.task_id
         WHERE t.assignee_name = ? AND a.down_seq IS NOT NULL AND a.down_seq > ? AND a.down_seq <= ? ORDER BY a.down_seq`,
      )
      .all(userName, since, max) as Array<Record<string, unknown>>
    for (const a of acks) down.push({ kind: 'ack', payload: a })

    const progress = this.db
      .prepare('SELECT * FROM task_progress WHERE assignee_name = ? AND down_seq > ? AND down_seq <= ? ORDER BY down_seq')
      .all(userName, since, max) as Array<Record<string, unknown>>
    for (const pr of progress) down.push({ kind: 'task_progress', payload: pr })

    // 坑（M9）：别人记的、锚在我正在做的步骤血缘上的——"正在做同一步的人
    // 实时收到别人记的坑"就是这条。作者自己不收回自己的。
    // 被驳回的也照发（带 status）——引擎对"新的跳过、已有的降回 personal"，
    // 这样已收到的人也能收到驳回结果，而不是揣着"未验证"过期。
    // 不走游标窗口，按状态全量重发：新任务用了旧血缘时，游标早已越过
    // 老坑（B 在有这个血缘的任务之前就在推拉了）。引擎按 id 幂等落库，
    // 重发只是多几个字节；上限兜底防膨胀。
    const lessons = this.db
      .prepare(
        `SELECT l.* FROM lessons l
         WHERE l.lineage_key IS NOT NULL AND l.author_name != ?
           AND l.lineage_key IN (
             SELECT DISTINCT s.lineage_key FROM steps s
             JOIN tasks t ON t.id = s.task_id
             WHERE t.assignee_name = ? AND s.lineage_key IS NOT NULL)
         ORDER BY l.down_seq DESC LIMIT 500`,
      )
      .all(userName, userName) as Array<Record<string, unknown>>
    for (const l of lessons.reverse()) down.push({ kind: 'lesson', payload: toLessonMirror(l) })

    // 底稿提议：我手里有同血缘步骤、提议还没被人处理掉。与坑同理由：
    // 窗口会漏掉"后来才用上该血缘"的引擎，按状态重发；已处理/已拒绝的
    // 引擎端按 dedup 不再建新提议。
    const proposals = this.db
      .prepare(
        `SELECT p.* FROM base_proposals p
         WHERE p.status = 'pending' AND p.from_name != ?
           AND p.lineage_key IN (
             SELECT DISTINCT s.lineage_key FROM steps s
             JOIN tasks t ON t.id = s.task_id
             WHERE t.assignee_name = ? AND s.lineage_key IS NOT NULL)
         ORDER BY p.down_seq`,
      )
      .all(userName, userName) as Array<Record<string, unknown>>
    for (const p of proposals) down.push({ kind: 'proposal', payload: toProposal(p) })

    // 点对点通知（确认/驳回结果回到作者手上）
    const notices = this.db
      .prepare('SELECT * FROM down_notices WHERE user_name = ? AND down_seq > ? AND down_seq <= ? ORDER BY down_seq')
      .all(userName, since, max) as Array<{ kind: string; payload_json: string }>
    for (const n of notices) {
      down.push({ kind: n.kind as DownItem['kind'], payload: JSON.parse(n.payload_json) as unknown })
    }

    return { down, lastDownSeq: max }
  }

  private nextDownSeq(): number {
    this.db.prepare('UPDATE down_seq SET seq = seq + 1 WHERE id = 1').run()
    return (this.db.prepare('SELECT seq FROM down_seq WHERE id = 1').get() as { seq: number }).seq
  }

  // ── 远程派任务（PL / 委派者 → 执行者）─────────────────────

  /** PL 或委派者派一个任务给某人：排队等对方引擎拉走。 */
  dispatchTask(input: {
    title: string
    briefMd?: string
    initiator: TeamUser
    assigneeName: string
    parentStepId?: string | null
    expectedMinutes?: number | null
    definitionOfDone?: string | null
  }): { id: string; downSeq: number } {
    const id = newId('tsk')
    const downSeq = this.nextDownSeq()
    this.db
      .prepare(
        `INSERT INTO dispatched_tasks (id, title, brief_md, initiator_name, assignee_name,
                                        parent_step_id, expected_minutes, definition_of_done, created_at, down_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.briefMd ?? '', input.initiator.name, input.assigneeName,
           input.parentStepId ?? null, input.expectedMinutes ?? null, input.definitionOfDone ?? null,
           Date.now(), downSeq)
    return { id, downSeq }
  }

  /**
   * 子任务进度 → 委派者的下行（一任务一行，有变化才换序号）。
   * 收件人是派活的人（dispatched_tasks.initiator_name）；没有派活记录时
   * 退回父步骤所在任务的执行者。
   */
  private refreshDelegationProgress(taskId: string): void {
    const task = this.db.prepare('SELECT status, parent_step_id FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; parent_step_id: string | null }
      | undefined
    if (task === undefined || task.parent_step_id === null) return

    const recipient =
      (this.db.prepare('SELECT initiator_name FROM dispatched_tasks WHERE id = ?').get(taskId) as { initiator_name: string } | undefined)?.initiator_name ??
      (this.db
        .prepare('SELECT t.assignee_name FROM tasks t JOIN steps s ON s.task_id = t.id WHERE s.id = ? LIMIT 1')
        .get(task.parent_step_id) as { assignee_name: string } | undefined)?.assignee_name
    if (recipient === undefined || recipient === '') return

    const counts = this.db
      .prepare("SELECT count(*) total, sum(CASE WHEN status IN ('ok','skipped') THEN 1 ELSE 0 END) done FROM steps WHERE task_id = ? AND kind != 'note'")
      .get(taskId) as { total: number; done: number | null }
    const worst = (this.db
      .prepare("SELECT level FROM alerts WHERE task_id = ? AND status = 'open' ORDER BY CASE level WHEN 'red' THEN 0 ELSE 1 END LIMIT 1")
      .get(taskId) as { level: string } | undefined)?.level ?? null
    const done = counts.done ?? 0

    const existing = this.db.prepare('SELECT status, done, total, worst_alert FROM task_progress WHERE task_id = ?').get(taskId) as
      | { status: string; done: number; total: number; worst_alert: string | null }
      | undefined
    if (
      existing !== undefined &&
      existing.status === task.status &&
      existing.done === done &&
      existing.total === counts.total &&
      existing.worst_alert === worst
    ) {
      return
    }
    this.db
      .prepare(
        `INSERT INTO task_progress (task_id, parent_step_id, assignee_name, status, done, total, worst_alert, updated_at, down_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET parent_step_id = excluded.parent_step_id, assignee_name = excluded.assignee_name,
           status = excluded.status, done = excluded.done, total = excluded.total, worst_alert = excluded.worst_alert,
           updated_at = excluded.updated_at, down_seq = excluded.down_seq`,
      )
      .run(taskId, task.parent_step_id, recipient, task.status, done, counts.total, worst, Date.now(), this.nextDownSeq())
  }

  /**
   * 这个人能不能看这个任务的镜像：管理员、发起人、执行者、委派者
   * （父步骤在他的任务里）、介入过的人（评论过、点过"知道了"）。
   * 原先任何令牌都能读任何任务——命令、输出、求助全在里面。
   */
  canView(taskId: string, user: Pick<TeamUser, 'name' | 'isAdmin'>): boolean {
    if (user.isAdmin) return true
    const t = this.taskById(taskId)
    if (t === null) return false
    if (t.initiatorName === user.name || t.assigneeName === user.name) return true
    if (t.parentStepId !== null) {
      const delegator = this.db
        .prepare('SELECT t.assignee_name FROM tasks t JOIN steps s ON s.task_id = t.id WHERE s.id = ? LIMIT 1')
        .get(t.parentStepId) as { assignee_name: string } | undefined
      if (delegator?.assignee_name === user.name) return true
    }
    const touched = this.db
      .prepare(
        `SELECT 1 AS hit FROM comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = @id AND u.name = @me
         UNION ALL
         SELECT 1 FROM alerts a JOIN users u ON u.id = a.acked_by WHERE a.task_id = @id AND u.name = @me
         LIMIT 1`,
      )
      .get({ id: taskId, me: user.name })
    return touched !== undefined
  }

  /** 这个用户是否已经有令牌（没有 = 引擎按名字自动建的占位，可被本人认领）。 */
  hasToken(userId: string): boolean {
    return this.db.prepare('SELECT 1 AS hit FROM tokens WHERE user_id = ? LIMIT 1').get(userId) !== undefined
  }

  listUsers(): Array<TeamUser & { taskCount: number }> {
    return (this.db
      .prepare(`SELECT u.*, (SELECT count(*) FROM tasks t WHERE t.assignee_name = u.name) AS task_count FROM users u ORDER BY u.created_at`)
      .all() as Array<{ id: string; name: string; display_name: string; is_admin: number; task_count: number }>)
      .map((r) => ({ id: r.id, name: r.name, displayName: r.display_name, isAdmin: r.is_admin === 1, taskCount: r.task_count }))
  }

  // ── 坑库与底稿提议（M9）──────────────────────────────────

  lessonById(id: string): LessonMirror | null {
    const r = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? null : toLessonMirror(r)
  }

  /** 用着这个血缘的任务的发起人（确认坑的权限判定：发起人=底稿负责人/PL）。 */
  lineageInitiators(lineageKey: string | null): string[] {
    if (lineageKey === null) return []
    return (
      this.db
        .prepare(
          `SELECT DISTINCT t.initiator_name FROM tasks t JOIN steps s ON s.task_id = t.id WHERE s.lineage_key = ?`,
        )
        .all(lineageKey) as Array<{ initiator_name: string }>
    ).map((r) => r.initiator_name)
  }

  /**
   * 确认/驳回坑（发起人或底稿负责人的动作）。确认后：
   * - 相关 🟡 待确认告警解除
   * - 结果通知作者（他的引擎把它标成已确认/降回 personal）
   */
  confirmLesson(id: string, by: TeamUser, accept: boolean): LessonMirror {
    const l = this.lessonById(id)
    if (l === null) throw new Error('坑不存在')
    if (l.status !== 'unverified') throw new Error('这个坑已经处理过了')
    const status = accept ? 'confirmed' : 'declined'
    this.db
      .prepare('UPDATE lessons SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?')
      .run(status, by.displayName, Date.now(), id)
    this.db
      .prepare("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE key LIKE ? AND status = 'open'")
      .run(Date.now(), `lesson:${id}:%`)
    this.addDownNotice(l.authorName, 'lesson_status', { id, status, by: by.displayName })
    return this.lessonById(id)!
  }

  /** 执行者把对底稿的偏离带回：所有有该血缘的其他执行者都会收到。 */
  createProposal(input: {
    lineageKey: string
    stepTitle: string
    beforeMd: string
    afterMd: string
    from: TeamUser
    fromTaskId: string | null
    fromTaskTitle: string | null
  }): { id: string } {
    const id = newId('prp')
    this.db
      .prepare(
        `INSERT INTO base_proposals (id, lineage_key, step_title, before_md, after_md,
                                     from_name, from_task_id, from_task_title, status, created_at, down_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, input.lineageKey, input.stepTitle, input.beforeMd, input.afterMd,
           input.from.name, input.fromTaskId, input.fromTaskTitle, Date.now(), this.nextDownSeq())
    return { id }
  }

  proposalById(id: string): BaseProposalRow | null {
    const r = this.db.prepare('SELECT * FROM base_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? null : toProposal(r)
  }

  /**
   * 提议裁定（某个执行者在自己的底稿上应用/拒绝后回报）。第一个裁定生效，
   * 后来者忽略——底稿只有一份，谁先处理谁定。
   */
  decideProposal(id: string, by: TeamUser, outcome: 'accepted' | 'declined' | 'conflict'): BaseProposalRow {
    const p = this.proposalById(id)
    if (p === null) throw new Error('提议不存在')
    if (p.status === 'pending') {
      this.db
        .prepare('UPDATE base_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(outcome, by.displayName, Date.now(), id)
      this.addDownNotice(p.fromName, 'proposal_status', { id, status: outcome, by: by.displayName, stepTitle: p.stepTitle })
    }
    return this.proposalById(id)!
  }

  /** 点对点下行通知（带下行序号，引擎按游标增量拉）。 */
  private addDownNotice(userName: string, kind: string, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO down_notices (id, user_name, kind, payload_json, down_seq) VALUES (?, ?, ?, ?, ?)')
      .run(newId('ntc'), userName, kind, JSON.stringify(payload), this.nextDownSeq())
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

  listTasks(
    scope: 'initiated' | 'assigned' | 'related',
    viewer: Pick<TeamUser, 'name' | 'isAdmin'>,
  ): Array<TaskMirror & { total: number; done: number; worstAlert: 'red' | 'yellow' | null }> {
    // related：我发起的 + 派给我的 + 我委派出去的 + 我评论/已读过的；管理员
    // 另外看得到"没指定发起人（发起人就是执行者本人）却发出了求助"的任务
    // ——没人派的活，求助总得有人接。原先这里是"任何人未回答的求助"，
    // 每个用户都能看到全队所有求助。
    const where =
      scope === 'initiated'
        ? 't.initiator_name = @me'
        : scope === 'assigned'
          ? 't.assignee_name = @me'
          : `t.initiator_name = @me OR t.assignee_name = @me
             OR t.parent_step_id IN (SELECT s.id FROM steps s JOIN tasks p ON p.id = s.task_id WHERE p.assignee_name = @me)
             OR t.id IN (SELECT c.task_id FROM comments c JOIN users u ON u.id = c.author_id WHERE u.name = @me)
             OR t.id IN (SELECT a.task_id FROM alerts a JOIN users u ON u.id = a.acked_by WHERE u.name = @me)
             OR (@admin = 1 AND t.initiator_name = t.assignee_name AND t.assignee_name != @me
                 AND t.id IN (SELECT q.task_id FROM questions q WHERE q.answer IS NULL))`
    const rows = this.db
      .prepare(`SELECT DISTINCT t.* FROM tasks t WHERE ${where} ORDER BY t.updated_at DESC`)
      .all({ me: viewer.name, admin: viewer.isAdmin ? 1 : 0 }) as Array<Record<string, unknown>>
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

  /**
   * 该我处理的告警：我发起的任务上的；我是管理员时，再加上没指定发起人
   * （发起人就是执行者本人）的任务——否则没人派的活卡住了谁都不知道。
   */
  openAlertsForUser(viewer: Pick<TeamUser, 'name' | 'isAdmin'>): AlertRow[] {
    return (this.db
      .prepare(
        `SELECT a.* FROM alerts a JOIN tasks t ON t.id = a.task_id
         WHERE a.status = 'open'
           AND (t.initiator_name = @me
                OR (@admin = 1 AND t.initiator_name = t.assignee_name AND t.assignee_name != @me))
         ORDER BY CASE a.level WHEN 'red' THEN 0 ELSE 1 END, a.updated_at DESC`,
      )
      .all({ me: viewer.name, admin: viewer.isAdmin ? 1 : 0 }) as Array<Record<string, unknown>>).map(toAlert)
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
    parentStepId: (r.parent_step_id as string | null) ?? null,
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
    lineageKey: (r.lineage_key as string | null) ?? null,
    lastOutput: (r.last_output as string | null) ?? null,
  }
}

function toLessonMirror(r: Record<string, unknown>): LessonMirror {
  return {
    id: r.id as string,
    lineageKey: (r.lineage_key as string | null) ?? null,
    symptom: r.symptom as string,
    cause: (r.cause as string | null) ?? null,
    fixMd: r.fix_md as string,
    condition: (r.condition as string | null) ?? null,
    authorName: r.author_name as string,
    taskId: (r.task_id as string | null) ?? null,
    taskTitle: (r.task_title as string | null) ?? null,
    status: r.status as LessonMirror['status'],
    confirmedBy: (r.confirmed_by as string | null) ?? null,
    confirmedAt: (r.confirmed_at as number | null) ?? null,
    createdAt: r.created_at as number,
  }
}

function toProposal(r: Record<string, unknown>): BaseProposalRow {
  return {
    id: r.id as string,
    lineageKey: r.lineage_key as string,
    stepTitle: r.step_title as string,
    beforeMd: r.before_md as string,
    afterMd: r.after_md as string,
    fromName: r.from_name as string,
    fromTaskId: (r.from_task_id as string | null) ?? null,
    fromTaskTitle: (r.from_task_title as string | null) ?? null,
    status: r.status as BaseProposalRow['status'],
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as number | null) ?? null,
    createdAt: r.created_at as number,
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
