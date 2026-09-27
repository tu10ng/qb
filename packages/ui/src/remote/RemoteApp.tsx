import { useCallback, useEffect, useState } from 'react'
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
  const [me, setMe] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (getToken() === '') return
    remoteApi
      .me()
      .then((u) => setMe(u.displayName))
      .catch(() => setAuthError('令牌无效，请重新登录'))
  }, [])

  if (me === null) {
    return <Login authError={authError} onLogin={setMe} />
  }
  return <RemoteMain me={me} onLogout={() => { clearToken(); setMe(null) }} />
}

function Login({ authError, onLogin }: { authError: string | null; onLogin: (name: string) => void }) {
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
        onLogin(r.user.displayName)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const loginWithToken = (): void => {
    setToken(token.trim())
    remoteApi
      .me()
      .then((u) => onLogin(u.displayName))
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

function RemoteMain({ me, onLogout }: { me: string; onLogout: () => void }) {
  const [overview, setOverview] = useState<{ initiated: RemoteTask[]; assigned: RemoteTask[]; openAlerts: RemoteAlert[] } | null>(null)
  const [openTask, setOpenTask] = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)

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
          <span className="dim">{me}</span>
        </div>
        <div className="task-list">
          {(overview?.initiated ?? []).map((t) => (
            <button key={t.id} className={`task-item${openTask === t.id ? ' active' : ''}`} onClick={() => setOpenTask(t.id)}>
              <span className={`gem ${t.worstAlert === 'red' ? 'stuck' : t.worstAlert === 'yellow' ? 'wobble' : 'ok'}`}>
                {t.worstAlert === 'red' ? '🔴' : t.worstAlert === 'yellow' ? '◐' : t.status === 'done' ? '✓' : '●'}
              </span>
              <span className="title">{t.title}</span>
            </button>
          ))}
          {overview !== null && overview.initiated.length === 0 && (
            <p className="dim" style={{ padding: 12 }}>
              还没有人给你同步过任务。执行端配置好「设置 · 团队」后，他执行的任务会出现在这里。
            </p>
          )}
        </div>
        <div className="sidebar-foot">
          <button className="btn ghost" onClick={() => setPushOpen(true)}>
            ⚙ 推送渠道
          </button>
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
        <RemoteTaskPage key={openTask} taskId={openTask} onChanged={refresh} />
      )}

      {overview !== null && overview.openAlerts.length > 0 && <LetterStack alerts={overview.openAlerts} onOpen={setOpenTask} />}
      {pushOpen && <PushChannelsDialog onClose={() => setPushOpen(false)} />}
    </div>
  )
}

/** 信件栈（右下角常驻）：缺氧式"小人被困住"。 */
function LetterStack({ alerts, onOpen }: { alerts: RemoteAlert[]; onOpen: (taskId: string) => void }) {
  const [open, setOpen] = useState(true)
  if (alerts.length === 0) return null
  return (
    <div className="letter-stack">
      <button className="letter-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▼' : '▲'} 🔴 {alerts.length}
      </button>
      {open &&
        alerts.map((a) => (
          <div key={a.key} className="letter red">
            <span>{a.message}</span>
            <div className="letter-actions">
              <button className="btn ghost" onClick={() => onOpen(a.taskId)}>
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

function RemoteTaskPage({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<RemoteDetail | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    remoteApi
      .task(taskId)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [taskId])

  useEffect(() => refresh(), [refresh])
  useEffect(() => connectRefresh(refresh), [refresh])

  if (detail === null) return <div className="empty-state">{error ?? '读取中…'}</div>
  const { task, steps } = detail

  const real = steps.filter((s) => s.kind !== 'note')
  const done = real.filter((s) => s.status === 'ok' || s.status === 'skipped').length
  const sectionOf = new Map(steps.map((s) => [s.id, s.title]))

  return (
    <div className="task-page">
      <header className="task-header">
        <h1>{task.title}</h1>
        <span className="task-meta">
          {task.assigneeName} 在做 · {done}/{real.length}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
          {task.startedAt !== null && ` · 已进行 ${Math.round((Date.now() - task.startedAt) / 60_000)} 分钟`}
        </span>
      </header>

      <div className="task-body">
        <nav className="outline">
          {steps.map((s) => (
            <div key={s.id} className={`outline-item${s.parentId !== null ? ' depth-1' : ''}${s.kind === 'note' ? ' section' : ''}`}>
              <span>{s.kind === 'note' ? '§' : markOf(s.status)}</span>
              <span className="t">{s.title}</span>
            </div>
          ))}
        </nav>

        <main className="runbook">
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

          {/* 打开的告警 */}
          {detail.alerts
            .filter((a) => a.status === 'open')
            .map((a) => (
              <div key={a.key} className={`adapt-card${a.level === 'red' ? '' : ' dim-alert'}`}>
                <div className="adapt-head">
                  <strong>{a.level === 'red' ? '🔴 需要你' : '🟡 值得一看'}</strong>
                  <span className="dim">{a.message}</span>
                  <span className="spacer" />
                  <button
                    className="btn ghost"
                    onClick={() => {
                      remoteApi.ack(a.key).then(refresh).catch(() => undefined)
                    }}
                  >
                    知道了
                  </button>
                </div>
              </div>
            ))}

          {steps.map((s) =>
            s.kind === 'note' ? (
              <div key={s.id} className="section-head">
                {s.title}
              </div>
            ) : (
              <div key={s.id} className={`step${s.status === 'failed' ? ' failed-cell' : ''}`}>
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
                {s.statusNote !== null && <div className="verdict fail">{s.statusNote}</div>}
                {/* 这一步上的评论 */}
                {detail.comments
                  .filter((c) => c.stepId === s.id)
                  .map((c) => (
                    <div key={c.id} className="remote-comment">
                      <strong>{c.authorName}</strong>：{c.body}
                    </div>
                  ))}
              </div>
            ),
          )}

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
              placeholder="留一条评论（可选中某一步后写）"
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              rows={2}
            />
            <button
              className="btn primary"
              disabled={commentDraft.trim() === ''}
              onClick={() => {
                remoteApi
                  .comment(taskId, commentDraft.trim())
                  .then(() => {
                    setCommentDraft('')
                    refresh()
                    onChanged()
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }}
            >
              评论
            </button>
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
    case 'task_started':
      return '开始执行'
    case 'task_done':
      return '完成了'
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
