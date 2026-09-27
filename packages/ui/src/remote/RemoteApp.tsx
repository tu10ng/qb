import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearToken,
  connectRefresh,
  getToken,
  remoteApi,
  setToken,
  type RemoteAlert,
  type RemoteDetail,
  type RemoteTask,
} from './remote.ts'

/**
 * 远程模式（发起人视角）：团队服务托管的同一套 UI。
 *
 * 只看、评论、回答、已读——不执行命令（宪法：团队服务永远不能让
 * 任何人的电脑执行命令）。右下角信件栈常驻：🔴 需要你 / 🟡 值得一看。
 */

export function RemoteApp() {
  const [me, setMe] = useState<{ displayName: string; isAdmin: boolean } | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  const load = useCallback(() => {
    remoteApi
      .me()
      .then((u) => setMe({ displayName: u.displayName, isAdmin: u.isAdmin }))
      .catch(() => setAuthError('令牌无效，请重新登录'))
  }, [])

  useEffect(() => {
    if (getToken() !== '') load()
  }, [load])

  if (me === null) {
    return <Login authError={authError} onLogin={load} />
  }
  return <RemoteMain me={me.displayName} isAdmin={me.isAdmin} onLogout={() => { clearToken(); setMe(null) }} />
}

function Login({ authError, onLogin }: { authError: string | null; onLogin: () => void }) {
  // 邀请链接形如 /#/join/<码>，进页面自动填上
  const inviteFromHash = /#\/join\/([A-Za-z0-9]+)/.exec(location.hash)?.[1] ?? ''
  const [invite, setInvite] = useState(inviteFromHash)
  const [name, setName] = useState('')
  const [token, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(authError)
  const [busy, setBusy] = useState(false)

  const join = (): void => {
    setBusy(true)
    setError(null)
    remoteApi
      .join(invite.trim(), name.trim())
      .then((r) => {
        setToken(r.token)
        onLogin()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const loginWithToken = (): void => {
    setToken(token.trim())
    remoteApi
      .me()
      .then(() => onLogin())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="empty-state">
      <div className="new-task-form">
        <h2 style={{ margin: 0 }}>QB · 团队</h2>
        {inviteFromHash !== '' ? (
          <>
            <p className="dim" style={{ margin: 0 }}>
              通过邀请链接进入，起个名字（同事怎么叫你）：
            </p>
            <input placeholder="你的名字，如 老王" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <button className="btn primary" disabled={busy || invite === '' || name.trim() === ''} onClick={join}>
              注册并进入
            </button>
          </>
        ) : (
          <>
            <p className="dim" style={{ margin: 0 }}>
              已注册过？粘贴你的个人令牌：
            </p>
            <input placeholder="个人令牌" value={token} onChange={(e) => setTokenInput(e.target.value)} autoFocus />
            <button className="btn primary" disabled={token.trim() === ''} onClick={loginWithToken}>
              进入
            </button>
            <p className="dim" style={{ margin: 0 }}>
              还没账号：找团队服务管理员要邀请链接（地址栏 #/join/…）。
            </p>
          </>
        )}
        {error !== null && <div className="verdict fail">{error}</div>}
      </div>
    </div>
  )
}

function RemoteMain({ me, isAdmin, onLogout }: { me: string; isAdmin: boolean; onLogout: () => void }) {
  const [overview, setOverview] = useState<{ initiated: RemoteTask[]; assigned: RemoteTask[]; openAlerts: RemoteAlert[] } | null>(null)
  const [openTask, setOpenTask] = useState<string | null>(null)
  // 信件"去看看"直达那一步（原先只打开任务，还得自己找是哪一步）
  const [focusStep, setFocusStep] = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)

  const refresh = useCallback(() => {
    remoteApi
      .overview()
      .then(setOverview)
      .catch(() => undefined)
  }, [])

  useEffect(() => refresh(), [refresh])
  useEffect(() => connectRefresh(refresh), [refresh])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">QB</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" title="派任务给同事" onClick={() => setDispatchOpen(true)}>
            ＋ 派任务
          </button>
          <span className="dim">{me}</span>
        </div>
        <div className="task-list">
          {(overview?.initiated ?? []).map((t) => (
            <button
              key={t.id}
              className={`task-item${openTask === t.id ? ' active' : ''}${t.status === 'done' || t.status === 'abandoned' ? ' ended' : ''}`}
              onClick={() => {
                setOpenTask(t.id)
                setFocusStep(null)
              }}
            >
              <span className={`gem ${t.worstAlert === 'red' || t.status === 'blocked' ? 'stuck' : t.worstAlert === 'yellow' ? 'wobble' : 'ok'}`}>
                {t.worstAlert === 'red' ? '🔴' : t.status === 'blocked' ? '○' : t.worstAlert === 'yellow' ? '◐' : t.status === 'done' ? '✓' : t.status === 'abandoned' ? '✕' : '●'}
              </span>
              <span className="title">{t.title}</span>
              <span className="dim">{t.assigneeName}</span>
            </button>
          ))}
          {overview !== null && overview.initiated.length === 0 && (
            <p className="dim" style={{ padding: 12 }}>
              还没有人给你同步过任务。执行端配置好「设置 · 团队」后，他执行的任务会出现在这里。
            </p>
          )}
        </div>
        <div className="sidebar-foot">
          {isAdmin && (
            <button className="btn ghost" onClick={() => setPushOpen(true)}>
              ⚙ 推送渠道
            </button>
          )}
          <button className="btn ghost" onClick={onLogout}>
            退出
          </button>
        </div>
      </aside>

      {openTask === null ? (
        <div className="empty-state">
          <p className="dim">选一个任务看进度。</p>
        </div>
      ) : (
        <RemoteTaskPage key={openTask} taskId={openTask} focusStepId={focusStep} onChanged={refresh} />
      )}

      {overview !== null && overview.openAlerts.length > 0 && (
        <LetterStack
          alerts={overview.openAlerts}
          onOpen={(taskId, stepId) => {
            setOpenTask(taskId)
            setFocusStep(stepId)
          }}
        />
      )}
      {pushOpen && <PushChannelsDialog onClose={() => setPushOpen(false)} />}
      {dispatchOpen && <DispatchDialog onClose={() => setDispatchOpen(false)} onDispatched={() => { refresh(); setTimeout(refresh, 4000); setTimeout(refresh, 8000) }} />}
    </div>
  )
}

/** 信件栈（右下角常驻）：缺氧式"小人被困住"。 */
function LetterStack({ alerts, onOpen }: { alerts: RemoteAlert[]; onOpen: (taskId: string, stepId: string | null) => void }) {
  const [open, setOpen] = useState(true)
  if (alerts.length === 0) return null
  const red = alerts.filter((a) => a.level === 'red').length
  const yellow = alerts.length - red
  return (
    <div className="letter-stack">
      <button className="letter-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▼' : '▲'} {red > 0 && `🔴 ${red}`} {yellow > 0 && `🟡 ${yellow}`}
      </button>
      {open &&
        alerts.map((a) => (
          <div key={a.key} className={`letter ${a.level}`}>
            <span>{a.message}</span>
            <div className="letter-actions">
              <button className="btn ghost" onClick={() => onOpen(a.taskId, a.stepId)}>
                去看看
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  remoteApi.ack(a.key).catch(() => undefined)
                }}
              >
                知道了
              </button>
            </div>
          </div>
        ))}
    </div>
  )
}

function RemoteTaskPage({ taskId, focusStepId, onChanged }: { taskId: string; focusStepId: string | null; onChanged: () => void }) {
  const [detail, setDetail] = useState<RemoteDetail | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // 选中的那一步：评论落在它上面（原先评论只能挂在任务上，占位文字却说可以选步骤）
  const [selected, setSelected] = useState<string | null>(focusStepId)
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const refresh = useCallback(() => {
    remoteApi
      .task(taskId)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [taskId])

  useEffect(() => refresh(), [refresh])
  useEffect(() => connectRefresh(refresh), [refresh])
  useEffect(() => setSelected(focusStepId), [focusStepId])
  // 从信件点进来：滚到那一步
  const loaded = detail !== null
  useEffect(() => {
    if (loaded && focusStepId !== null) stepRefs.current[focusStepId]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [loaded, focusStepId])

  if (detail === null) return <div className="empty-state">{error ?? '读取中…'}</div>
  const { task, steps } = detail

  const real = steps.filter((s) => s.kind !== 'note')
  const done = real.filter((s) => s.status === 'ok' || s.status === 'skipped').length
  const sectionOf = new Map(steps.map((s) => [s.id, s.title]))
  const selectedStep = steps.find((s) => s.id === selected) ?? null
  const blockedEvent = [...detail.events].reverse().find((e) => e.kind === 'task_blocked')

  const sendComment = (): void => {
    if (commentDraft.trim() === '') return
    remoteApi
      .comment(taskId, commentDraft.trim(), selected)
      .then(() => {
        setCommentDraft('')
        refresh()
        onChanged()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="task-page">
      <header className="task-header">
        <h1>{task.title}</h1>
        <span className="task-meta">
          {task.assigneeName} {task.status === 'done' ? '已完成' : task.status === 'abandoned' ? '已放弃' : task.status === 'blocked' ? '卡住了' : '在做'} · {done}/{real.length}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
          {task.startedAt !== null && task.status !== 'done' && ` · 已进行 ${Math.round((Date.now() - task.startedAt) / 60_000)} 分钟`}
        </span>
      </header>

      <div className="task-body">
        <nav className="outline">
          {steps.map((s) => (
            <button
              key={s.id}
              className={`outline-item${s.parentId !== null ? ' depth-1' : ''}${s.kind === 'note' ? ' section' : ''}${s.id === selected ? ' current' : ''}`}
              onClick={() => {
                setSelected(s.id)
                stepRefs.current[s.id]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }}
            >
              <span>{s.kind === 'note' ? '§' : markOf(s.status)}</span>
              <span className="t">{s.title}</span>
            </button>
          ))}
        </nav>

        <main className="runbook">
          {task.status === 'blocked' && (
            <div className="banner danger">
              {task.assigneeName} 卡住了
              {typeof blockedEvent?.payload.note === 'string' && blockedEvent.payload.note !== '' ? `：${blockedEvent.payload.note}` : ''}
              。可以在下面选中那一步留言，或者直接找他。
            </div>
          )}
          {/* 待回答的求助最显眼 */}
          {detail.questions
            .filter((q) => q.answer === null)
            .map((q) => (
              <div key={q.id} className="adapt-card" style={{ borderColor: 'var(--danger)' }}>
                <div className="adapt-head">
                  <strong>🔔 {q.askerName} 在求助</strong>
                </div>
                <pre className="adapt-cmd">{q.body}</pre>
                <textarea
                  placeholder="一句话回答（会直接出现在他的那一步上）"
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((m) => ({ ...m, [q.id]: e.target.value }))}
                  rows={2}
                />
                <div className="adapt-actions">
                  <button
                    className="btn primary"
                    disabled={(answers[q.id] ?? '').trim() === ''}
                    onClick={() => {
                      remoteApi
                        .answer(q.id, answers[q.id]!.trim())
                        .then(() => {
                          refresh()
                          onChanged()
                        })
                        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    }}
                  >
                    回答
                  </button>
                </div>
              </div>
            ))}

          {/* 打开的告警。坑待确认（lesson_pending）给 [确认有效]/[不用了] 而不是"知道了" */}
          {detail.alerts
            .filter((a) => a.status === 'open')
            .map((a) => {
              const lessonMatch = a.type === 'lesson_pending' ? /^lesson:([^:]+):/.exec(a.key) : null
              return (
                <div key={a.key} className={`adapt-card${a.level === 'red' ? '' : ' dim-alert'}`}>
                  <div className="adapt-head">
                    <strong>{a.level === 'red' ? '🔴 需要你' : '🟡 值得一看'}</strong>
                    <span className="dim">{a.message}</span>
                    <span className="spacer" />
                    {lessonMatch !== null ? (
                      <>
                        <button
                          className="btn primary"
                          onClick={() => {
                            remoteApi.confirmLesson(lessonMatch[1]!, true).then(refresh).catch(() => undefined)
                          }}
                        >
                          确认有效
                        </button>
                        <button
                          className="btn ghost"
                          onClick={() => {
                            remoteApi.confirmLesson(lessonMatch[1]!, false).then(refresh).catch(() => undefined)
                          }}
                        >
                          不用了
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn ghost"
                        onClick={() => {
                          remoteApi.ack(a.key).then(refresh).catch(() => undefined)
                        }}
                      >
                        知道了
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

          {steps.map((s) =>
            s.kind === 'note' ? (
              <div key={s.id} className="section-head">
                {s.title}
              </div>
            ) : (
              <div
                key={s.id}
                ref={(el) => {
                  stepRefs.current[s.id] = el
                }}
                className={`step${s.status === 'failed' ? ' failed-cell' : ''}${s.id === selected ? ' current' : ''}`}
                onClick={() => setSelected(s.id)}
              >
                <div className="step-head">
                  <span className="step-mark">{markOf(s.status)}</span>
                  <span className="step-title">{s.title}</span>
                  <span className="step-hint">
                    {s.expectedMinutes !== null ? `预计 ${s.expectedMinutes} 分钟` : ''}
                    {s.actualMs !== null ? ` · ${Math.round(s.actualMs / 1000)}s` : ''}
                  </span>
                </div>
                {s.command !== null && (
                  <div className="cmd">
                    <pre>{s.command}</pre>
                  </div>
                )}
                {s.lastOutput !== null && s.lastOutput !== undefined && (
                  <div className="shared-output">
                    <span className="dim">他共享的输出：</span>
                    <pre>{s.lastOutput}</pre>
                  </div>
                )}
                {s.statusNote !== null && <div className="verdict fail">{s.statusNote}</div>}
                {/* 这一步上的评论 */}
                {detail.comments
                  .filter((c) => c.stepId === s.id)
                  .map((c) => (
                    <div key={c.id} className="remote-comment">
                      <strong>{c.authorName}</strong>：{c.body}
                    </div>
                  ))}
                {s.id === selected && (
                  <div className="step-actions" onClick={(e) => e.stopPropagation()}>
                    <input
                      className="inline-edit"
                      autoFocus={focusStepId === s.id}
                      placeholder={`对「${s.title}」说一句（他在这一步上直接看到）`}
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') sendComment()
                      }}
                      style={{ flex: 1 }}
                    />
                    <button className="btn primary" disabled={commentDraft.trim() === ''} onClick={sendComment}>
                      评论这一步
                    </button>
                  </div>
                )}
              </div>
            ),
          )}

          {/* 任务层面的评论（没选步骤时发的） */}
          {detail.comments
            .filter((c) => c.stepId === null)
            .map((c) => (
              <div key={c.id} className="remote-comment">
                <strong>{c.authorName}</strong>：{c.body}
              </div>
            ))}

          {/* 已回答的求助（留档） */}
          {detail.questions
            .filter((q) => q.answer !== null)
            .map((q) => (
              <div key={q.id} className="remote-comment">
                <strong>问过 {q.askerName}</strong>：{q.body}
                <br />
                <strong>{q.answeredByName} 答</strong>：{q.answer}
              </div>
            ))}
        </main>

        <aside className="qb-panel">
          <h2>进展</h2>
          <div className="qb-feed">
            {detail.events.length === 0 ? (
              <p className="dim">还没有事件。</p>
            ) : (
              detail.events
                .slice()
                .reverse()
                .map((e, i) => (
                  <div className="qb-msg" key={i}>
                    {remoteEventText(e.kind, e.payload, sectionOf)}
                    <div className="when">
                      {e.actorName ?? ''} {new Date(e.createdAt).toLocaleTimeString('zh-CN')}
                    </div>
                  </div>
                ))
            )}
          </div>
          <div className="qb-actions">
            <textarea
              placeholder={selectedStep !== null ? `评论「${selectedStep.title}」` : '留一条评论（点左边或正文里的某一步，评论就落在那一步上）'}
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              rows={2}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn primary" disabled={commentDraft.trim() === ''} onClick={sendComment}>
                {selectedStep !== null ? '评论这一步' : '评论任务'}
              </button>
              {selectedStep !== null && (
                <button className="btn ghost" onClick={() => setSelected(null)}>
                  不针对某一步
                </button>
              )}
            </div>
            {error !== null && <div className="verdict fail">{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  )
}

function markOf(status: string): string {
  switch (status) {
    case 'ok':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '▶'
    case 'skipped':
      return '⤼'
    default:
      return '○'
  }
}

function remoteEventText(kind: string, payload: Record<string, unknown>, sectionOf: Map<string, string>): string {
  const stepTitle = typeof payload.title === 'string' ? payload.title : ''
  const which = stepTitle !== '' ? `「${stepTitle}」` : ''
  switch (kind) {
    case 'task_created':
      return '任务创建'
    case 'task_started':
      return '开始执行'
    case 'task_done':
      return '完成了'
    case 'task_blocked':
      return `卡住了${typeof payload.note === 'string' && payload.note !== '' ? `：${payload.note}` : ''}`
    case 'task_resumed':
      return payload.auto === true ? '又开始动手了' : '不卡了，继续'
    case 'task_abandoned':
      return `放弃了${typeof payload.note === 'string' && payload.note !== '' ? `：${payload.note}` : ''}`
    case 'task_reopened':
      return '重新打开了任务'
    case 'alert_raised':
      return `QB 替他开口：${typeof payload.message === 'string' ? payload.message : ''}`
    case 'alert_snoozed':
      return `他说能搞定，${typeof payload.minutes === 'number' ? payload.minutes : 30} 分钟内先别提醒`
    case 'step_run':
      return `开始 ${which}`
    case 'step_ok':
      return `${which}通过`
    case 'step_failed':
      return `${which}失败${typeof payload.reason === 'string' && payload.reason !== '' ? `（${payload.reason}）` : ''}`
    case 'step_timeout':
      return `${which}超时`
    case 'step_skipped':
      return `跳过了${which}`
    case 'edit':
      return '改了内容'
    case 'replanned':
      return typeof payload.reason === 'string' ? payload.reason : '重新规划'
    case 'question_asked':
      return `发出了求助${typeof payload.body === 'string' ? `：${payload.body.slice(0, 80)}` : ''}`
    case 'question_answered':
      return `求助有了回答：${typeof payload.answer === 'string' ? payload.answer.slice(0, 80) : ''}`
    case 'comment':
      return `评论：${typeof payload.body === 'string' ? payload.body.slice(0, 80) : ''}`
    case 'lesson_proposed':
      return payload.shared === true ? '记了个坑（已共享）' : '记了个坑'
    case 'lesson_shared':
      return `${typeof payload.by === 'string' ? payload.by : '同事'} 在${which || '某一步'}记了个坑：${typeof payload.symptom === 'string' ? payload.symptom.slice(0, 60) : ''}`
    case 'lesson_confirmed':
      return payload.status === 'confirmed' ? '一个共享的坑被确认有效' : '一个共享的坑被判定无效'
    case 'base_proposal':
      return `底稿提议：${typeof payload.stepTitle === 'string' ? payload.stepTitle : ''}`
    case 'delegate_progress': {
      const who = typeof payload.assignee === 'string' ? payload.assignee : '对方'
      if (payload.note === '已委派') return `把${which || '一步'}委派给了 ${who}`
      return `委派出去的${which || '一步'}：${who} ${typeof payload.total === 'number' && payload.total > 0 ? `${String(payload.done)}/${payload.total}` : String(payload.status ?? '')}`
    }
    default:
      return kind
  }
}


/** 推送渠道：通用 webhook（企业微信/飞书/钉钉群机器人都吃 JSON）或
 * 外部命令（python 脚本：JSON 走 stdin，纯文本在 QB_ALERT_TEXT）。 */
function PushChannelsDialog({ onClose }: { onClose: () => void }) {
  const [channels, setChannels] = useState<Array<{ id: string; name: string; kind: 'webhook' | 'command'; config: Record<string, unknown>; minLevel: 'red' | 'yellow'; enabled: boolean }>>([])
  const [kind, setKind] = useState<'webhook' | 'command'>('webhook')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [minLevel, setMinLevel] = useState<'red' | 'yellow'>('red')
  const [result, setResult] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    remoteApi
      .channels()
      .then((r) => setChannels(r.channels))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => refresh(), [refresh])

  const add = (): void => {
    remoteApi
      .saveChannel({
        name: name.trim() === '' ? (kind === 'webhook' ? 'Webhook' : '脚本') : name.trim(),
        kind,
        config: kind === 'webhook' ? { url: url.trim() } : { command: command.trim() },
        minLevel,
        enabled: true,
      })
      .then(refresh)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>推送渠道</h3>
        <p className="dim">🔴 告警（需要你）会推给启用的渠道。webhook 收 POST JSON（text 字段是纯文本）；命令渠道给 python 脚本用：JSON 走 stdin，纯文本在环境变量 QB_ALERT_TEXT。</p>
        {channels.map((c) => (
          <div key={c.id} className="param-row">
            <code className="param-name">{c.name}</code>
            <span className="dim" style={{ flex: 1 }}>
              {c.kind === 'webhook' ? String(c.config.url ?? '') : String(c.config.command ?? '')}
            </span>
            <button
              className="btn ghost"
              onClick={() => {
                remoteApi
                  .testChannel(c.id)
                  .then((r) => setResult((m) => ({ ...m, [c.id]: r })))
                  .catch((e: unknown) => setResult((m) => ({ ...m, [c.id]: { ok: false, detail: e instanceof Error ? e.message : String(e) } })))
              }}
            >
              测试
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                remoteApi.deleteChannel(c.id).then(refresh).catch(() => undefined)
              }}
            >
              删
            </button>
          </div>
        ))}
        {channels.map((c) => result[c.id] !== undefined && (
          <div key={c.id} className={result[c.id]!.ok ? 'verdict pass' : 'verdict fail'}>
            {result[c.id]!.detail}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'webhook' | 'command')}>
            <option value="webhook">Webhook</option>
            <option value="command">命令 / Python</option>
          </select>
          {kind === 'webhook' ? (
            <input placeholder="https://qyapi.weixin.qq.com/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          ) : (
            <input placeholder="python push.py --room 部署组" value={command} onChange={(e) => setCommand(e.target.value)} style={{ flex: 1 }} />
          )}
          <select value={minLevel} onChange={(e) => setMinLevel(e.target.value as 'red' | 'yellow')}>
            <option value="red">只推 🔴</option>
            <option value="yellow">🔴 和 🟡</option>
          </select>
          <input placeholder="名字（可选）" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 120 }} />
          <button className="btn primary" disabled={kind === 'webhook' ? url.trim() === '' : command.trim() === ''} onClick={add}>
            添加
          </button>
        </div>
        {error !== null && <div className="verdict fail">{error}</div>}
        <div className="row">
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}


/** 派任务：PL 在远程 UI 直接派活给执行者（他要先在团队服务注册）。 */
function DispatchDialog({ onClose, onDispatched }: { onClose: () => void; onDispatched: () => void }) {
  const [users, setUsers] = useState<Array<{ name: string; displayName: string; taskCount: number }>>([])
  const [assignee, setAssignee] = useState('')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    remoteApi
      .users()
      .then((r) => {
        setUsers(r.users)
        if (r.users.length > 0) setAssignee(r.users[0]!.name)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const submit = (): void => {
    setBusy(true)
    setError(null)
    const mins = minutes.trim() === '' ? undefined : Number(minutes)
    remoteApi
      .dispatch({
        title: title.trim(),
        briefMd: brief,
        assigneeName: assignee,
        ...(mins !== undefined && Number.isFinite(mins) && mins > 0 ? { expectedMinutes: mins } : {}),
      })
      .then(() => {
        onClose()
        onDispatched()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>派任务</h3>
        <p className="dim">像写 prompt 一样写目标。对方引擎几秒内收到，你这边实时看到进度与告警。</p>
        <label>
          派给
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            {users.map((u) => (
              <option key={u.name} value={u.name}>
                {u.displayName}（{u.taskCount} 个任务）
              </option>
            ))}
          </select>
        </label>
        <input placeholder="标题：如「在 Y 集群把 vLLM PD 分离跑通」" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <textarea placeholder="详细说明（目标、约束、已知的坑——就像给 agent 写 prompt）" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} />
        <input placeholder="预计耗时（分钟，可选）" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ maxWidth: 200 }} />
        <div className="row">
          <button className="btn primary" disabled={busy || title.trim() === '' || assignee === ''} onClick={submit}>
            {busy ? '派出…' : '派给他'}
          </button>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
        {users.length === 0 && <p className="dim">还没有注册的执行者。让对方先打开团队服务的邀请链接注册。</p>}
        {error !== null && <div className="verdict fail">{error}</div>}
      </div>
    </div>
  )
}
