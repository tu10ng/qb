/**
 * 引擎 ↔ 团队服务同步（M8）。
 *
 * 上行：新事件（含快照的任务）、告警决策、未推的求助 —— POST /api/sync/push
 * 下行：评论 / 求助回答 / 已读确认 —— 同一响应里带回来，落到本地事件流
 *
 * 原则（方案 §7.1）：
 * - 单写者：本机是任务数据唯一写者，团队侧只收快照
 * - 上传前脱敏：命令过 redact（模板本身不含参数值，secret 参数永不出本机）
 * - 离线照常工作：同步失败只记日志，绝不影响本地；游标不动，下次续传
 * - 透明：谁替执行者发了什么，都有一条本地事件
 */

import { evaluateAlerts, redact, tailCap } from '@qb/core'
import type { Store } from '@qb/store'

export interface TeamConfig {
  url: string
  token: string
  enabled: boolean
}

const TEAM_KEY = 'team'

/** 团队配置（settings 表；key 不出本机）。 */
export class TeamSettings {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  get(): TeamConfig {
    return this.store.getSetting<TeamConfig>(TEAM_KEY) ?? { url: '', token: '', enabled: false }
  }

  save(next: TeamConfig): TeamConfig {
    this.store.setSetting(TEAM_KEY, next)
    return next
  }
}

export interface SyncDeps {
  store: Store
  /** 本地用户名（推给团队做展示与身份映射）。 */
  userName: () => string
  /** 广播给本地 UI（评论/回答/已读到达时刷新）。 */
  broadcast: (data: unknown) => void
  /** 日志（同步失败要可见但不刷屏）。 */
  log: (msg: string) => void
}

export interface SyncState {
  /** 已成功推送的本地事件 seq。 */
  pushedSeq: number
  /** 下行游标（团队侧序号）。 */
  downSeq: number
}

const STATE_KEY = 'sync'

export type Sync = ReturnType<typeof createSync>

export function createSync(deps: SyncDeps) {
  const { store, userName, broadcast, log } = deps

  /** 本机用户 id（"派给自己的任务"的 initiator 兜底） */
  function userNameAsId(): string {
    return store.getUserByName(userName())?.id ?? ''
  }
  let warnedOffline = false
  // 重入锁：一拍 2 秒而 fetch 超时 20 秒——不锁的话最多十个并发推送，
  // 各自拿旧游标，完成乱序时会把 downSeq 写回旧值
  let pushing = false

  const state = (): SyncState =>
    store.getSyncState<SyncState>(STATE_KEY) ?? { pushedSeq: store.maxEventSeq(), downSeq: 0 }

  const setState = (s: SyncState): void => store.setSyncState(STATE_KEY, s)

  /** 团队服务可达性 + 令牌有效性（设置页的"测试连接"用）。 */
  async function testConnection(cfg: TeamConfig): Promise<{ ok: boolean; detail: string }> {
    try {
      const me = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/me`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (me.status === 401) return { ok: false, detail: '令牌无效（到团队服务注册/换一个）' }
      if (!me.ok) return { ok: false, detail: `HTTP ${me.status}` }
      const user = (await me.json()) as { displayName: string }
      return { ok: true, detail: `已连上，身份是「${user.displayName}」` }
    } catch (e) {
      return { ok: false, detail: `连不上：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  function pushNow(): void {
    const cfg = new TeamSettings(store).get()
    if (!cfg.enabled || cfg.url === '' || cfg.token === '') return
    if (pushing) return
    pushing = true
    void pushOnce(cfg)
      .catch((e: unknown) => {
        if (!warnedOffline) {
          log(`团队同步失败（不影响本地使用）：${e instanceof Error ? e.message : String(e)}`)
          warnedOffline = true
        }
      })
      .finally(() => {
        pushing = false
      })
  }

  async function pushOnce(cfg: TeamConfig): Promise<void> {
    const st = state()
    const events = store.eventsAfter(st.pushedSeq)
    const unpushedQuestions = store.listUnpushedQuestions()
    // 脏任务 = 有新事件的 + 有待推求助的。后者必须并入：求助的 task 可能
    // 早就没有新事件了（比如只剩一条没推成功的求助），不带快照过去，
    // 团队侧的外键就挂了。
    const dirtyTaskIds = [...new Set([...events.map((e) => e.taskId), ...unpushedQuestions.map((q) => q.taskId)])]

    // 快照：脏任务的当前全量（任务 + 步骤树）。命令过脱敏——手写命令
    // 里可能嵌着 token，模板参数值本来就不在内。
    const me = store.getUserByName(userName())
    const tasks = dirtyTaskIds.map((taskId) => {
      const task = store.getTask(taskId)!
      const latest = store.getLatestRunbook(taskId)
      const initiator = store.getUser(task.initiatorId)
      const assignee = store.getUser(task.assigneeId)
      return {
        id: task.id,
        title: task.title,
        briefMd: redact(task.briefMd).text,
        initiatorName: initiator?.name ?? '',
        assigneeName: assignee?.name ?? '',
        status: task.status,
        expectedMinutes: task.expectedMinutes,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        runbookVersion: latest?.runbook.version ?? null,
        steps: (latest?.steps ?? []).map((s) => {
          // share_output 开启时带上最新输出（脱敏 + 4KB 截尾）
          let lastOutput: string | null = null
          if (s.shareOutput === true) {
            const evs = store.listEvidence(s.id)
            const last = evs.length > 0 ? evs[evs.length - 1]! : null
            if (last?.text != null) lastOutput = tailCap(redact(last.text).text, 4096).text
          }
          return {
            taskId,
            id: s.id,
            parentId: s.parentId,
            orderKey: s.orderKey,
            kind: s.kind,
            title: s.title,
            command: s.command === null ? null : redact(s.command).text,
            status: s.status,
            expectedMinutes: s.expectedMinutes,
            actualMs: s.actualMs,
            statusNote: s.statusNote,
            ...(lastOutput !== null ? { lastOutput } : {}),
          }
        }),
      }
    })

    // 告警：脏任务的当前决策集（全量——不在集合里的现存告警由团队侧解除）
    const alerts = dirtyTaskIds.flatMap((taskId) => {
      const task = store.getTask(taskId)
      const latest = store.getLatestRunbook(taskId)
      if (task === null || latest === null) return []
      return evaluateAlerts({
        now: Date.now(),
        task,
        steps: latest.steps,
        // 200 条窗口：求助未回答的红告警靠回溯事件判断，窗口太小会在
        // 活跃任务上静默解除
        events: store.listEvents(taskId, 200),
      }).map((d) => ({ key: d.key, taskId: d.taskId, stepId: d.stepId, level: d.level, type: d.type, message: d.message, at: d.at }))
    })

    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/sync/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user: { name: userName(), displayName: me?.displayName ?? userName() },
        sinceDownSeq: st.downSeq,
        tasks,
        events: events.map((e) => ({
          taskId: e.taskId,
          engineSeq: e.seq,
          stepId: e.stepId,
          actorName: store.getUser(e.actorId ?? '')?.name ?? (e.actorId === null ? 'QB' : null),
          kind: e.kind,
          payload: e.payload,
          createdAt: e.createdAt,
        })),
        alerts,
        questions: unpushedQuestions.map((q) => ({ id: q.id, taskId: q.taskId, stepId: q.stepId, body: q.bodyMd, createdAt: q.createdAt })),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`团队服务返回 HTTP ${res.status}`)
    const result = (await res.json()) as {
      down: Array<{ kind: 'comment' | 'answer' | 'ack' | 'task' | 'task_progress'; payload: Record<string, unknown> }>
      lastDownSeq: number
    }

    // 下行落地 + 游标推进同一个事务：崩在中间也不会重复拉同一批下行
    store.inTransaction(() => {
      applyDown(result.down)
      store.markQuestionsPushed(unpushedQuestions.map((q) => q.id))
      setState({ pushedSeq: st.pushedSeq + events.length, downSeq: result.lastDownSeq })
    })

    if (warnedOffline) {
      log('团队同步已恢复')
      warnedOffline = false
    }
  }

  /** 下行落地：派来的任务 / 评论 / 回答 / 已读 / 委派进度，都成为本地可见的东西。 */
  function applyDown(items: Array<{ kind: string; payload: Record<string, unknown> }>): void {
    const touchedTasks = new Set<string>()
    for (const item of items) {
      if (item.kind === 'task') {
        const p = item.payload
        const taskId = String(p.id ?? '')
        if (taskId === '' || store.getTask(taskId) !== null) continue // 幂等
        const initiatorName = String(p.initiator_name ?? '')
        const initiator = initiatorName !== '' ? store.ensureUser(initiatorName) : null
        const task = store.createTask({
          id: taskId,
          title: String(p.title ?? ''),
          briefMd: String(p.brief_md ?? ''),
          initiatorId: initiator !== null ? initiator.id : userNameAsId(),
          // 派来的任务归本机执行者
          parentStepId: p.parent_step_id !== undefined && p.parent_step_id !== null ? String(p.parent_step_id) : null,
          expectedMinutes: p.expected_minutes !== undefined && p.expected_minutes !== null ? Number(p.expected_minutes) : null,
          definitionOfDone: p.definition_of_done !== undefined && p.definition_of_done !== null ? String(p.definition_of_done) : null,
        })
        store.appendEvent({ taskId: task.id, actorId: null, kind: 'task_created', payload: { by: initiatorName, remote: true } })
        touchedTasks.add(task.id)
        continue
      }
      if (item.kind === 'task_progress') {
        const p = item.payload
        // 委派出去的子任务的进度：更新本地子任务状态 + 事件
        const childId = String(p.task_id ?? '')
        const child = store.getTask(childId)
        if (child === null) continue
        const remoteStatus = String(p.status ?? 'active')
        const done = Number(p.done ?? 0)
        const total = Number(p.total ?? 0)
        const progressText = `${done}/${total}`
        // 只更新 status（引擎侧只关心子任务是否完成）
        if (remoteStatus === 'done' && child.status !== 'done') {
          store.updateTaskStatus(childId, 'done', null)
          // 父步骤标 ok
          if (child.parentStepId !== null) {
            const step = store.getStep(child.parentStepId)
            if (step !== null && step.status !== 'ok') {
              store.updateStepStatus(step.id, 'ok', { endedAt: Date.now() })
            }
          }
          store.appendEvent({ taskId: childId, actorId: null, kind: 'task_done', payload: { remote: true } })
          touchedTasks.add(childId)
        } else if (child.status !== remoteStatus && remoteStatus === 'blocked') {
          store.updateTaskStatus(childId, 'blocked', null)
          store.appendEvent({ taskId: childId, actorId: null, kind: 'delegate_progress', payload: { status: remoteStatus, progress: progressText } })
          touchedTasks.add(childId)
        } else {
          store.appendEvent({ taskId: childId, actorId: null, kind: 'delegate_progress', payload: { status: remoteStatus, progress: progressText } })
          touchedTasks.add(childId)
        }
        continue
      }
      if (item.kind === 'comment') {
        const p = item.payload
        const taskId = String(p.task_id ?? '')
        const commentId = String(p.id ?? '')
        // 按 id 去重：响应丢失重放时同一条评论不能落两次
        if (commentId !== '' && store.hasEventWithPayloadId('comment', commentId)) continue
        const body = redact(String(p.body ?? '')).text
        store.appendEvent({
          taskId,
          stepId: p.step_id !== undefined && p.step_id !== null ? String(p.step_id) : null,
          actorId: null,
          kind: 'comment',
          payload: { author: String(p.author_name ?? ''), body, commentId },
        })
        touchedTasks.add(taskId)
      } else if (item.kind === 'answer') {
        const p = item.payload
        const qid = String(p.id ?? '')
        const answer = redact(String(p.answer ?? '')).text
        if (store.answerQuestion(qid, answer)) {
          const q = store.getQuestion(qid)
          if (q !== null) {
            store.appendEvent({
              taskId: q.taskId,
              stepId: q.stepId,
              actorId: null,
              kind: 'question_answered',
              payload: { answer, by: String(p.answered_by_name ?? '发起人'), questionId: qid },
            })
            touchedTasks.add(q.taskId)
          }
        }
      } else if (item.kind === 'ack') {
        const p = item.payload
        const taskId = String(p.task_id ?? '')
        store.appendEvent({
          taskId,
          actorId: null,
          kind: 'alert_acked',
          payload: { by: '发起人', at: p.acked_at },
        })
        touchedTasks.add(taskId)
      }
    }
    for (const taskId of touchedTasks) broadcast({ type: 'runbook.changed', taskId, stepId: null })
  }

  return { pushNow, pushOnce, testConnection, applyDown }
}
