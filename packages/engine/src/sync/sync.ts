/**
 * 引擎 ↔ 团队服务同步（M8，Phase 0 重做了身份、告警与委派回流）。
 *
 * 上行：新事件（含快照的任务）、告警决策、未推的求助 —— POST /api/sync/push
 * 下行：评论 / 求助回答 / 已读确认 / 派来的任务 / 委派进度 —— 同一响应里带回来
 *
 * 原则（方案 §7.1）：
 * - 单写者：本机是任务数据唯一写者，团队侧只收快照
 * - 上传前脱敏：命令过 redact（模板本身不含参数值，secret 参数永不出本机）
 * - 离线照常工作：同步失败只记日志，绝不影响本地；游标不动，下次续传
 * - 透明：谁替执行者发了什么，都有一条本地事件
 *
 * 告警不只在"有新事件"时算：人卡住不动恰恰没有事件（停滞、失控、没有
 * 动静都是这种），所以 evaluateNow 定时把所有进行中的任务重算一遍，
 * 决策集变了就把任务标脏推上去。
 */

import { evaluateAlerts, redact, tailCap, type AlertDecision, type AlertThresholds, type Task } from '@qb/core'
import type { Store } from '@qb/store'

export interface TeamIdentity {
  name: string
  displayName: string
}

export interface TeamConfig {
  url: string
  token: string
  enabled: boolean
  /**
   * 令牌在团队服务上对应的身份（保存/测试配置时从 /api/me 取）。推送一律
   * 用它——原先用本机用户名（默认 me），和令牌持有者对不上，每一拍都 403。
   */
  identity?: TeamIdentity | null
}

const TEAM_KEY = 'team'

/** 团队配置（settings 表；key 不出本机）。 */
export class TeamSettings {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  get(): TeamConfig {
    return this.store.getSetting<TeamConfig>(TEAM_KEY) ?? { url: '', token: '', enabled: false, identity: null }
  }

  save(next: TeamConfig): TeamConfig {
    this.store.setSetting(TEAM_KEY, next)
    return next
  }
}

export interface SyncDeps {
  store: Store
  /** 本机用户名（还没拿到团队身份时的兜底）。 */
  userName: () => string
  /** 本机当前用户 id：任务快照里把它映射成团队身份。 */
  currentUserId: () => string
  /** 广播给本地 UI（评论/回答/已读到达时刷新）。 */
  broadcast: (data: unknown) => void
  /** 日志（同步失败要可见但不刷屏）。 */
  log: (msg: string) => void
  /** 运行中步骤的最近输出时间（失控告警要分清"在跑"和"卡死"）。 */
  lastOutputAt?: () => ReadonlyMap<string, number>
  /** 告警阈值覆盖（环境变量 QB_ALERT_*，e2e 用短阈值）。 */
  thresholds?: Partial<AlertThresholds>
}

export interface SyncState {
  /** 已成功推送的本地事件 seq。 */
  pushedSeq: number
  /** 下行游标（团队侧序号）。 */
  downSeq: number
}

/** 最近一次同步的结果（设置页与侧栏显示真实状态，不再无条件显示"同步中"）。 */
export interface SyncStatus {
  /** null = 还没推过。 */
  ok: boolean | null
  at: number | null
  detail: string
}

const STATE_KEY = 'sync'
/** 已经"告诉过发起人"的红告警 key（按任务），重启后不重复记透明事件。 */
const RAISED_KEY = 'alerts-raised'

export type Sync = ReturnType<typeof createSync>

export function createSync(deps: SyncDeps) {
  const { store, userName, currentUserId, broadcast, log } = deps

  let warnedOffline = false
  // 重入锁：一拍 2 秒而 fetch 超时 20 秒——不锁的话最多十个并发推送，
  // 各自拿旧游标，完成乱序时会把 downSeq 写回旧值
  let pushing = false
  let status: SyncStatus = { ok: null, at: null, detail: '还没同步过' }

  // 告警决策集的指纹：推送成功后记下；定时重算时变了就强制推这个任务
  const lastPushedSig = new Map<string, string>()
  const forcedDirty = new Set<string>()

  const state = (): SyncState =>
    store.getSyncState<SyncState>(STATE_KEY) ?? { pushedSeq: store.maxEventSeq(), downSeq: 0 }

  const setState = (s: SyncState): void => store.setSyncState(STATE_KEY, s)

  const config = (): TeamConfig => new TeamSettings(store).get()

  /** 推送用的身份：团队身份优先，没有时退回本机用户名。 */
  const teamName = (cfg: TeamConfig): string => cfg.identity?.name ?? userName()

  /** 本机用户 id → 团队里的名字（本机当前用户映射成团队身份）。 */
  const nameOf = (userId: string, cfg: TeamConfig): string =>
    userId === currentUserId() ? teamName(cfg) : (store.getUser(userId)?.name ?? '')

  /** 本机用户 id（"派给自己的任务"的 initiator 兜底） */
  const meId = (): string => currentUserId()

  /** 团队服务可达性 + 令牌有效性，顺带拿到令牌对应的身份。 */
  async function fetchIdentity(cfg: Pick<TeamConfig, 'url' | 'token'>): Promise<{ ok: boolean; detail: string; identity?: TeamIdentity }> {
    try {
      const me = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/me`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (me.status === 401) return { ok: false, detail: '令牌无效（到团队服务注册/换一个）' }
      if (!me.ok) return { ok: false, detail: `HTTP ${me.status}` }
      const user = (await me.json()) as { name: string; displayName: string }
      return { ok: true, detail: `已连上，身份是「${user.displayName}」`, identity: { name: user.name, displayName: user.displayName } }
    } catch (e) {
      return { ok: false, detail: `连不上：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 设置页的"测试连接"。 */
  async function testConnection(cfg: TeamConfig): Promise<{ ok: boolean; detail: string; identity?: TeamIdentity }> {
    return fetchIdentity(cfg)
  }

  // ── 告警 ──────────────────────────────────────────────────

  /** 一个任务当前应当存在的告警（去掉执行者静音了的）。 */
  function decisionsFor(task: Task): AlertDecision[] {
    const latest = store.getLatestRunbook(task.id)
    return evaluateAlerts({
      now: Date.now(),
      task,
      steps: latest?.steps ?? [],
      // 200 条窗口：求助未回答的红告警靠回溯事件判断，窗口太小会在
      // 活跃任务上静默解除
      events: store.listEvents(task.id, 200),
      ...(deps.lastOutputAt !== undefined ? { lastOutputAt: deps.lastOutputAt() } : {}),
      ...(deps.thresholds !== undefined ? { thresholds: deps.thresholds } : {}),
    }).filter((d) => !store.isSnoozed(task.id, d.key))
  }

  const signature = (ds: AlertDecision[]): string =>
    ds
      .map((d) => `${d.key}|${d.level}`)
      .sort()
      .join(',')

  /**
   * 透明（宪法 15）：红告警第一次出现时，在执行者自己的时间线记一条
   * "QB 替你告诉了 X"。发起人就是自己（没人派的活）时不记——没告诉任何人。
   */
  function noteRaised(task: Task, decisions: AlertDecision[]): void {
    if (task.initiatorId === task.assigneeId) return
    const raised = store.getSyncState<Record<string, string[]>>(RAISED_KEY) ?? {}
    const before = new Set(raised[task.id] ?? [])
    const reds = decisions.filter((d) => d.level === 'red')
    const initiator = store.getUser(task.initiatorId)
    for (const d of reds) {
      if (before.has(d.key)) continue
      store.appendEvent({
        taskId: task.id,
        stepId: d.stepId,
        actorId: null,
        kind: 'alert_raised',
        payload: { key: d.key, type: d.type, message: d.message, to: initiator?.displayName ?? initiator?.name ?? '发起人' },
      })
      broadcast({ type: 'runbook.changed', taskId: task.id, stepId: d.stepId })
    }
    const now = reds.map((d) => d.key)
    if (now.length === 0) delete raised[task.id]
    else raised[task.id] = now
    if (now.length > 0 || before.size > 0) store.setSyncState(RAISED_KEY, raised)
  }

  /**
   * 定时重算：所有我在执行的、没结束的任务。决策集和上次推上去的不一样
   * （出现了新的停滞/失控/没有动静，或者条件消失了）就强制推这个任务。
   */
  function evaluateNow(): void {
    const cfg = config()
    if (!cfg.enabled || cfg.url === '' || cfg.token === '') return
    for (const task of store.listTasks({ assigneeId: meId() })) {
      const ended = task.status === 'done' || task.status === 'abandoned'
      if (ended && (lastPushedSig.get(task.id) ?? '') === '') continue
      const decisions = ended ? [] : decisionsFor(task)
      if (signature(decisions) !== (lastPushedSig.get(task.id) ?? '')) forcedDirty.add(task.id)
      if (!ended) noteRaised(task, decisions)
    }
    if (forcedDirty.size > 0) pushNow()
  }

  // ── 推送 ──────────────────────────────────────────────────

  function pushNow(): void {
    const cfg = config()
    if (!cfg.enabled || cfg.url === '' || cfg.token === '') return
    if (pushing) return
    pushing = true
    void pushOnce(cfg)
      .catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e)
        status = { ok: false, at: Date.now(), detail }
        if (!warnedOffline) {
          log(`团队同步失败（不影响本地使用）：${detail}`)
          warnedOffline = true
        }
      })
      .finally(() => {
        pushing = false
      })
  }

  async function pushOnce(cfgIn: TeamConfig): Promise<void> {
    let cfg = cfgIn
    // 老配置没有团队身份：先补上（否则推送身份对不上令牌，必 403）
    if (cfg.identity == null) {
      const r = await fetchIdentity(cfg)
      if (!r.ok || r.identity === undefined) throw new Error(r.detail)
      cfg = new TeamSettings(store).save({ ...cfg, identity: r.identity })
    }

    const st = state()
    const events = store.eventsAfter(st.pushedSeq)
    const unpushedQuestions = store.listUnpushedQuestions()
    // 脏任务 = 有新事件的 + 有待推求助的 + 定时重算发现告警变了的。求助
    // 必须并入：求助的 task 可能早就没有新事件了（比如只剩一条没推成功的
    // 求助），不带快照过去，团队侧的外键就挂了。
    const dirtyTaskIds = [...new Set([...events.map((e) => e.taskId), ...unpushedQuestions.map((q) => q.taskId), ...forcedDirty])]
    const dirtyTasks = dirtyTaskIds.map((id) => store.getTask(id)).filter((t): t is Task => t !== null)

    // 告警：脏任务的当前决策集（全量——不在集合里的现存告警由团队侧解除）
    const decisions = new Map(
      dirtyTasks.map((t) => [t.id, t.status === 'done' || t.status === 'abandoned' ? [] : decisionsFor(t)] as const),
    )
    for (const t of dirtyTasks) noteRaised(t, decisions.get(t.id) ?? [])

    // 快照：脏任务的当前全量（任务 + 步骤树）。命令过脱敏——手写命令
    // 里可能嵌着 token，模板参数值本来就不在内。
    const tasks = dirtyTasks.map((task) => {
      const latest = store.getLatestRunbook(task.id)
      return {
        id: task.id,
        title: task.title,
        briefMd: redact(task.briefMd).text,
        initiatorName: nameOf(task.initiatorId, cfg),
        assigneeName: nameOf(task.assigneeId, cfg),
        status: task.status,
        // 委派产生的子任务要带父步骤：团队据此把进度回给委派者（原先漏了，
        // 委派进度一条都没回流过）
        parentStepId: task.parentStepId,
        expectedMinutes: task.expectedMinutes,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        runbookVersion: latest?.runbook.version ?? null,
        steps: (latest?.steps ?? []).map((s) => {
          // share_output 开启时带上最新输出（脱敏 + 4KB 截尾）
          let lastOutput: string | null = null
          if (s.shareOutput === true) {
            const evs = store.listEvidence(s.id)
            const last = [...evs].reverse().find((e) => e.text !== null)
            if (last?.text != null) lastOutput = tailCap(redact(last.text).text, 4096).text
          }
          return {
            taskId: task.id,
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
            // 血缘必须随快照走：团队按它把坑路由给正在做同一步的人（M9）
            ...(s.lineageKey !== null ? { lineageKey: s.lineageKey } : {}),
            ...(lastOutput !== null ? { lastOutput } : {}),
          }
        }),
      }
    })

    const alerts = dirtyTasks.flatMap((t) =>
      (decisions.get(t.id) ?? []).map((d) => ({ key: d.key, taskId: d.taskId, stepId: d.stepId, level: d.level, type: d.type, message: d.message, at: d.at })),
    )

    // 待共享的坑（M9）：脱敏后整条上传；只有血缘锚定的才值得共享。
    // 上传名单在 fetch 前定死——事务里重新拉全量会把 fetch 窗口内（最长
    // 20 秒）新接受的坑误标 uploaded=1，从此永不上传。
    const lessonsToSend = store
      .listLessonsToUpload()
      .filter((l) => l.anchorKind === 'step_lineage' && l.anchorRef !== null)

    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/sync/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user: { name: teamName(cfg), displayName: cfg.identity?.displayName ?? teamName(cfg) },
        sinceDownSeq: st.downSeq,
        tasks,
        events: events.map((e) => ({
          taskId: e.taskId,
          engineSeq: e.seq,
          stepId: e.stepId,
          actorName: e.actorId === null ? 'QB' : nameOf(e.actorId, cfg) || null,
          kind: e.kind,
          payload: e.payload,
          createdAt: e.createdAt,
        })),
        alerts,
        questions: unpushedQuestions.map((q) => ({ id: q.id, taskId: q.taskId, stepId: q.stepId, body: q.bodyMd, createdAt: q.createdAt })),
        lessons: lessonsToSend.map((l) => ({
          id: l.id,
          lineageKey: l.anchorRef!,
          symptom: redact(l.symptom).text,
          cause: l.cause === null ? null : redact(l.cause).text,
          fixMd: redact(l.fixMd).text,
          condition: l.condition === null ? null : redact(l.condition).text,
          taskId: l.sourceTaskId,
          taskTitle: l.sourceTaskId !== null ? (store.getTask(l.sourceTaskId)?.title ?? null) : null,
          createdAt: l.createdAt,
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(`团队服务返回 HTTP ${res.status}${typeof body?.message === 'string' ? `：${body.message}` : ''}`)
    }
    const result = (await res.json()) as {
      down: Array<{ kind: string; payload: Record<string, unknown> }>
      lastDownSeq: number
    }

    // 下行落地 + 游标推进同一个事务：崩在中间也不会重复拉同一批下行
    store.inTransaction(() => {
      applyDown(result.down)
      store.markQuestionsPushed(unpushedQuestions.map((q) => q.id))
      // 只标记本次真送出去的那批（团队按 id 幂等，重传安全，但没必要）
      store.markLessonsUploaded(lessonsToSend.map((l) => l.id))
      setState({ pushedSeq: events.length > 0 ? events[events.length - 1]!.seq : st.pushedSeq, downSeq: result.lastDownSeq })
    })

    for (const t of dirtyTasks) {
      lastPushedSig.set(t.id, signature(decisions.get(t.id) ?? []))
      forcedDirty.delete(t.id)
    }
    status = { ok: true, at: Date.now(), detail: `已同步，身份是「${cfg.identity?.displayName ?? teamName(cfg)}」` }

    if (warnedOffline) {
      log('团队同步已恢复')
      warnedOffline = false
    }
  }

  /** 下行落地：派来的任务 / 评论 / 回答 / 已读 / 委派进度，都成为本地可见的东西。 */
  function applyDown(items: Array<{ kind: string; payload: Record<string, unknown> }>): void {
    const touchedTasks = new Set<string>()
    for (const item of items) {
      // 一项坏了只跳过这一项：原先一条落不了库的下行会让整批回滚、游标不动，
      // 这台引擎从此每一拍都失败，什么都同步不了
      try {
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
            initiatorId: initiator !== null ? initiator.id : meId(),
            // 派来的任务归本机执行者。原先漏了这一行，执行者默认成了发起人，
            // 本机任务列表（按执行者过滤）里根本看不到派来的活
            assigneeId: meId(),
            parentStepId: p.parent_step_id !== undefined && p.parent_step_id !== null ? String(p.parent_step_id) : null,
            expectedMinutes: p.expected_minutes !== undefined && p.expected_minutes !== null ? Number(p.expected_minutes) : null,
            definitionOfDone: p.definition_of_done !== undefined && p.definition_of_done !== null ? String(p.definition_of_done) : null,
          })
          store.appendEvent({ taskId: task.id, actorId: null, kind: 'task_created', payload: { by: initiator?.displayName ?? initiatorName, remote: true } })
          touchedTasks.add(task.id)
          continue
        }
        if (item.kind === 'task_progress') {
          // 我委派出去的那一步：对方进度回流到委派行上，对方完成则这一步完成
          const p = item.payload
          const stepId = String(p.parent_step_id ?? '')
          const delegation = store.delegationOf(stepId)
          const taskId = stepId !== '' ? store.taskIdOfStep(stepId) : null
          if (delegation === null || taskId === null) continue
          const worst = p.worst_alert
          const next: { status: string; done: number; total: number; worstAlert: 'red' | 'yellow' | null } = {
            status: String(p.status ?? 'active'),
            done: Number(p.done ?? 0),
            total: Number(p.total ?? 0),
            worstAlert: worst === 'red' || worst === 'yellow' ? worst : null,
          }
          const before = store.updateDelegationProgress(stepId, next)
          const step = store.getStep(stepId)
          if (step === null || before === null) continue
          const who = delegation.assigneeName
          if (next.status === 'done' && step.status !== 'ok') {
            store.updateStepStatus(stepId, 'ok', { endedAt: Date.now() })
            store.appendEvent({ taskId, stepId, actorId: null, kind: 'step_ok', payload: { source: 'delegate', by: who, reason: `${who} 完成了` } })
          } else if (next.status === 'abandoned' && step.status !== 'failed') {
            store.updateStepStatus(stepId, 'failed', { endedAt: Date.now(), note: `${who} 放弃了这个任务` })
            store.appendEvent({ taskId, stepId, actorId: null, kind: 'step_failed', payload: { source: 'delegate', by: who, reason: `${who} 放弃了` } })
          } else if (before.status !== next.status || before.done !== next.done || before.worstAlert !== next.worstAlert) {
            store.appendEvent({ taskId, stepId, actorId: null, kind: 'delegate_progress', payload: { assignee: who, ...next } })
          }
          touchedTasks.add(taskId)
          continue
        }
        if (item.kind === 'comment') {
          const p = item.payload
          const taskId = String(p.task_id ?? '')
          const commentId = String(p.id ?? '')
          // 按 id 去重：响应丢失重放时同一条评论不能落两次
          if (commentId !== '' && store.hasEventWithPayloadId('comment', commentId, 'commentId')) continue
          if (store.getTask(taskId) === null) continue
          const body = redact(String(p.body ?? '')).text
          const stepId = p.step_id !== undefined && p.step_id !== null ? String(p.step_id) : null
          store.appendEvent({
            taskId,
            stepId: stepId !== null && store.getStep(stepId) !== null ? stepId : null,
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
              // 捕获时机 5：发起人回答到达 → 提议沉淀成坑（M9）
              if (q.answerMd !== null) {
                store.createLessonOffer({
                  taskId: q.taskId,
                  stepId: q.stepId,
                  kind: 'question',
                  dedupKey: qid,
                  payload: { questionId: qid, question: q.bodyMd, answer },
                })
              }
              touchedTasks.add(q.taskId)
            }
          }
        } else if (item.kind === 'lesson') {
          const p = item.payload
          const lessonId = String(p.id ?? '')
          if (lessonId === '') continue
          // 被发起人驳回的坑不再进场；已在本地的降回 personal（团队侧已
          // 过滤，这里兜底重放旧下行的情况）
          if (String(p.status ?? '') === 'declined') {
            if (store.lessonById(lessonId) !== null) store.setRemoteLessonStatus(lessonId, 'declined')
            continue
          }
          if (store.lessonById(lessonId) !== null) continue // 幂等
          const lesson = store.upsertRemoteLesson({
            id: lessonId,
            anchorRef: String(p.lineage_key ?? p.lineageKey ?? ''),
            symptom: redact(String(p.symptom ?? '')).text,
            cause: p.cause == null ? null : redact(String(p.cause)).text,
            fixMd: redact(String(p.fix_md ?? p.fixMd ?? '')).text,
            condition: p.condition == null ? null : String(p.condition),
            authorName: String(p.author_name ?? p.authorName ?? '同事'),
            localAuthorId: meId(),
            confirmed: p.status === 'confirmed',
            createdAt: Number(p.created_at ?? p.createdAt ?? Date.now()),
          })
          // 挂到含该血缘的任务上：时间线可见"谁在这一步记了个坑"（宪法 15：透明）
          if (lesson !== null && lesson.anchorRef !== '') {
            for (const task of store.listTasks({})) {
              const latest = store.getLatestRunbook(task.id)
              if (latest === null) continue
              const step = latest.steps.find((s) => s.lineageKey === lesson.anchorRef)
              if (step === undefined) continue
              store.appendEvent({
                taskId: task.id,
                stepId: step.id,
                actorId: null,
                kind: 'lesson_shared',
                payload: { lessonId: lesson.id, by: lesson.authorName, symptom: lesson.symptom.slice(0, 80) },
              })
              touchedTasks.add(task.id)
            }
          }
        } else if (item.kind === 'lesson_status') {
          // 我传的坑被确认/驳回了：确认 → 打戳；驳回 → 降回 personal
          const p = item.payload
          const lessonId = String(p.id ?? '')
          if (store.lessonById(lessonId) !== null) {
            store.setRemoteLessonStatus(lessonId, p.status === 'confirmed' ? 'confirmed' : 'declined')
            const lesson = store.lessonById(lessonId)
            if (lesson?.sourceTaskId != null) {
              store.appendEvent({
                taskId: lesson.sourceTaskId,
                actorId: null,
                kind: 'lesson_confirmed',
                payload: { lessonId, status: String(p.status ?? ''), by: String(p.by ?? '') },
              })
              touchedTasks.add(lesson.sourceTaskId)
            }
          }
        } else if (item.kind === 'proposal') {
          // 别人把他对底稿的偏离提议带回来：落成本地提议，持有底稿的人处理
          const p = item.payload
          const proposalId = String(p.id ?? '')
          const lineageKey = String(p.lineage_key ?? p.lineageKey ?? '')
          if (proposalId === '' || lineageKey === '') continue
          // 找到自己哪个任务有该血缘（提议挂在那个任务下）
          let taskId: string | null = null
          let stepId: string | null = null
          for (const task of store.listTasks({})) {
            const latest = store.getLatestRunbook(task.id)
            if (latest === null) continue
            const step = latest.steps.find((s) => s.lineageKey === lineageKey)
            if (step !== undefined) {
              taskId = task.id
              stepId = step.id
              break
            }
          }
          if (taskId === null) continue
          store.createLessonOffer({
            taskId,
            stepId,
            kind: 'proposal',
            dedupKey: `prp:${proposalId}`,
            payload: {
              remoteId: proposalId,
              lineageKey,
              stepTitle: String(p.step_title ?? p.stepTitle ?? ''),
              before: String(p.before_md ?? p.beforeMd ?? ''),
              after: String(p.after_md ?? p.afterMd ?? ''),
              fromName: String(p.from_name ?? p.fromName ?? ''),
              fromTaskTitle: String(p.from_task_title ?? p.fromTaskTitle ?? ''),
            },
          })
          store.appendEvent({
            taskId,
            stepId,
            actorId: null,
            kind: 'base_proposal',
            payload: { from: String(p.from_name ?? p.fromName ?? ''), stepTitle: String(p.step_title ?? p.stepTitle ?? '') },
          })
          touchedTasks.add(taskId)
        } else if (item.kind === 'proposal_status') {
          // 我带回底稿的提议被处理了：按提议 id 精确找落地的任务——接受方
          // 的 proposal 提议 dedup 是 prp:<id>；发起方的 deviation 提议送出后
          // payload 里带 remoteId，两条路都试
          const p = item.payload
          const remoteId = String(p.id ?? '')
          const offer = store.findLessonOfferByDedup('proposal', `prp:${remoteId}`) ?? (remoteId !== '' ? store.findLessonOfferByRemoteId(remoteId) : null)
          if (offer === null) continue
          store.appendEvent({
            taskId: offer.taskId,
            stepId: offer.stepId,
            actorId: null,
            kind: 'base_proposal',
            payload: { decided: String(p.status ?? ''), by: String(p.by ?? ''), stepTitle: String(offer.payload.stepTitle ?? '') },
          })
          touchedTasks.add(offer.taskId)
        } else if (item.kind === 'ack') {
          const p = item.payload
          const taskId = String(p.task_id ?? '')
          if (store.getTask(taskId) === null) continue
          store.appendEvent({
            taskId,
            actorId: null,
            kind: 'alert_acked',
            payload: { by: '发起人', at: p.acked_at, key: p.key },
          })
          touchedTasks.add(taskId)
        }
      } catch (e) {
        log(`下行的一项没能落地（跳过，其余照常）：${item.kind} · ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const taskId of touchedTasks) broadcast({ type: 'runbook.changed', taskId, stepId: null })
  }

  return {
    pushNow,
    pushOnce,
    evaluateNow,
    testConnection,
    fetchIdentity,
    applyDown,
    status: (): SyncStatus => status,
  }
}
