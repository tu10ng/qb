import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Step, Task } from '@qb/core'
import { api, connectEvents, type ServerEvent, type TaskDetail } from './api.ts'
import { StepCell, formatMs, type StepRunState } from './StepCell.tsx'

export function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [runStates, setRunStates] = useState<Record<string, StepRunState>>({})
  const [focusMode, setFocusMode] = useState(false)
  const [currentStepId, setCurrentStepId] = useState<string | null>(null)

  const refreshTasks = useCallback(async () => {
    setTasks(await api.listTasks())
  }, [])

  const refreshDetail = useCallback(async (taskId: string) => {
    setDetail(await api.taskDetail(taskId))
  }, [])

  useEffect(() => {
    void refreshTasks()
  }, [refreshTasks])

  useEffect(() => {
    if (activeId === null) return
    void refreshDetail(activeId)
  }, [activeId, refreshDetail])

  // 事件流：步骤输出、完成、重规划
  useEffect(() => {
    return connectEvents((e: ServerEvent) => {
      switch (e.type) {
        case 'step.status':
          setRunStates((s) => ({
            ...s,
            [e.stepId]: { ...(s[e.stepId] ?? { output: '' }), running: e.status === 'running' },
          }))
          break

        case 'step.output':
          setRunStates((s) => {
            const prev = s[e.stepId] ?? { output: '', running: true }
            return { ...s, [e.stepId]: { ...prev, output: prev.output + e.text } }
          })
          break

        case 'step.done':
          setRunStates((s) => ({
            ...s,
            [e.stepId]: {
              ...(s[e.stepId] ?? { output: '' }),
              running: false,
              verdict: e.verdict,
              reason: e.reason,
              durationMs: e.durationMs,
              redactionHits: e.redactionHits,
            },
          }))
          // 状态已落库，重新拉一次让步骤标记与任务状态同步
          setActiveId((id) => {
            if (id !== null) void refreshDetail(id)
            return id
          })
          void refreshTasks()
          break

        case 'step.error':
          setRunStates((s) => ({
            ...s,
            [e.stepId]: {
              ...(s[e.stepId] ?? { output: '' }),
              running: false,
              verdict: 'fail',
              reason: e.message,
            },
          }))
          break

        case 'runbook.updated':
          setActiveId((id) => {
            if (id === e.taskId) void refreshDetail(id)
            return id
          })
          break
      }
    })
  }, [refreshDetail, refreshTasks])

  // 当前步：优先第一个未完成的，用户点击可覆盖
  const steps = detail?.steps ?? []
  const autoCurrent = useMemo(
    () => steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending'),
    [steps],
  )
  const currentId = currentStepId ?? autoCurrent?.id ?? null

  // j/k 上下步
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'f') return

      if (e.key === 'f') {
        setFocusMode((v) => !v)
        return
      }
      const idx = steps.findIndex((s) => s.id === currentId)
      const next = e.key === 'j' ? idx + 1 : idx - 1
      if (next >= 0 && next < steps.length) setCurrentStepId(steps[next]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps, currentId])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">QB</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => setActiveId(null)}>
            ＋
          </button>
        </div>
        <div className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={`task-item${t.id === activeId ? ' active' : ''}`}
              onClick={() => {
                setActiveId(t.id)
                setCurrentStepId(null)
              }}
            >
              <span className={`gem ${gemClass(t)}`}>{gem(t)}</span>
              <span className="title">{t.title}</span>
            </button>
          ))}
        </div>
      </aside>

      {activeId === null || detail === null ? (
        <NewTask
          onCreated={async (task) => {
            await refreshTasks()
            setActiveId(task.id)
          }}
        />
      ) : (
        <TaskPage
          detail={detail}
          runStates={runStates}
          currentId={currentId}
          focusMode={focusMode}
          onToggleFocus={() => setFocusMode((v) => !v)}
          onSelectStep={setCurrentStepId}
          onChanged={() => void refreshDetail(detail.task.id)}
        />
      )}
    </div>
  )
}

// ── 任务页 ────────────────────────────────────────────────────

interface TaskPageProps {
  detail: TaskDetail
  runStates: Record<string, StepRunState>
  currentId: string | null
  focusMode: boolean
  onToggleFocus: () => void
  onSelectStep: (id: string) => void
  onChanged: () => void
}

function TaskPage({
  detail,
  runStates,
  currentId,
  focusMode,
  onToggleFocus,
  onSelectStep,
  onChanged,
}: TaskPageProps) {
  const { task, runbook, steps } = detail
  const currentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentId])

  const done = steps.filter((s) => s.status === 'ok').length
  const visible = focusMode ? steps.filter((s) => s.id === currentId) : steps

  return (
    <div className="task-page">
      <header className="task-header">
        <h1>{task.title}</h1>
        <span className="task-meta">
          <span className={`gem ${gemClass(task)}`}>{gem(task)}</span> {statusLabel(task)} ·{' '}
          {done}/{steps.length}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onToggleFocus}>
          {focusMode ? '退出专注 (f)' : '专注模式 (f)'}
        </button>
      </header>

      <div className={`task-body${focusMode ? ' focus-mode' : ''}`}>
        <nav className="outline">
          {steps.map((s) => (
            <button
              key={s.id}
              className={`outline-item${s.id === currentId ? ' current' : ''}${
                s.parentId !== null ? ' depth-1' : ''
              }`}
              onClick={() => onSelectStep(s.id)}
            >
              <span>{outlineMark(s)}</span>
              <span className="t">{s.title}</span>
            </button>
          ))}
        </nav>

        <main className="runbook">
          {runbook !== null && runbook.assumptions.length > 0 && (
            <div className="assumptions">
              <h3>假设</h3>
              {runbook.assumptions.map((a) => (
                <div className="row" key={a.key}>
                  <span className="k">{a.key}</span>
                  <span>{a.value}</span>
                </div>
              ))}
            </div>
          )}

          {steps.length === 0 && <DraftPrompt taskId={task.id} onDrafted={onChanged} />}

          {visible.map((s) => (
            <div key={s.id} ref={s.id === currentId ? currentRef : undefined}>
              <StepCell
                step={s}
                current={s.id === currentId}
                runState={runStates[s.id]}
                evidence={detail.evidence[s.id] ?? []}
                onFocus={() => onSelectStep(s.id)}
                onChanged={onChanged}
              />
            </div>
          ))}
        </main>

        <aside className="qb-panel">
          <h2>QB</h2>
          <div className="qb-feed">
            {detail.events.length === 0 ? (
              <p style={{ color: 'var(--text-faint)' }}>还没有事件。</p>
            ) : (
              detail.events
                .slice()
                .reverse()
                .map((e) => (
                  <div className="qb-msg" key={e.id}>
                    {eventText(e.kind, e.payload)}
                    <div className="when">{new Date(e.createdAt).toLocaleTimeString('zh-CN')}</div>
                  </div>
                ))
            )}
          </div>
          <div className="qb-actions">
            <button className="btn">情况变了…</button>
            <button className="btn">问发起人</button>
            {steps.length > 0 && <RedraftButton taskId={task.id} onDone={onChanged} />}
          </div>
        </aside>
      </div>
    </div>
  )
}

// ── 起草 ──────────────────────────────────────────────────────

/**
 * 空 runbook 时的起草入口。
 *
 * 起草要等模型几十秒，期间明确告诉用户在等什么——干等一个转圈
 * 不知道要等多久是最烦人的。
 */
function DraftPrompt({ taskId, onDrafted }: { taskId: string; onDrafted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  const draft = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setElapsed(0)
    try {
      await api.draft(taskId)
      onDrafted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (busy) {
    return (
      <p style={{ color: 'var(--text-dim)' }}>
        QB 正在起草……已等待 {elapsed} 秒。它在检索团队的 skill 和坑，并按你的环境渲染命令。
      </p>
    )
  }

  return (
    <div style={{ color: 'var(--text-dim)' }}>
      <p>还没有 runbook。</p>
      <button className="btn primary" onClick={() => void draft()}>
        让 QB 起草
      </button>
      {error !== null && (
        <p className="verdict fail" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}
    </div>
  )
}

/** 重新起草。旧版本会保留，不会丢。 */
function RedraftButton({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <button
        className="btn ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          api
            .draft(taskId)
            .then(onDone)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'QB 起草中…' : '让 QB 重新起草'}
      </button>
      {error !== null && (
        <div className="verdict fail" style={{ fontSize: 12 }}>
          {error}
        </div>
      )}
    </>
  )
}

// ── 新任务 ────────────────────────────────────────────────────

function NewTask({ onCreated }: { onCreated: (t: Task) => void | Promise<void> }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (title.trim() === '') return
    setBusy(true)
    try {
      const task = await api.createTask({ title: title.trim(), briefMd: brief })
      setTitle('')
      setBrief('')
      await onCreated(task)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="empty-state">
      <div className="new-task-form">
        <input
          placeholder="要做什么？"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          autoFocus
        />
        <textarea
          placeholder="详细说明（就像给 agent 写 prompt：目标、约束、已知的坑）"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>
          创建
        </button>
      </div>
    </div>
  )
}

// ── 展示辅助 ──────────────────────────────────────────────────

/** 灵魂宝石：亮 = 顺利，变暗 = 有波折，熄灭 = 卡住需要介入。 */
function gem(t: Task): string {
  return t.status === 'blocked' ? '○' : t.status === 'done' ? '✓' : '●'
}

function gemClass(t: Task): string {
  return t.status === 'blocked' ? 'stuck' : t.status === 'draft' ? 'wobble' : 'ok'
}

function statusLabel(t: Task): string {
  switch (t.status) {
    case 'draft':
      return '草稿'
    case 'active':
      return '进行中'
    case 'blocked':
      return '卡住'
    case 'done':
      return '完成'
    case 'abandoned':
      return '已放弃'
  }
}

function outlineMark(s: Step): string {
  switch (s.status) {
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

function eventText(kind: string, payload: Record<string, unknown>): string {
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  const ms = typeof payload.durationMs === 'number' ? ` (${formatMs(payload.durationMs)})` : ''

  switch (kind) {
    case 'task_started':
      return '任务开始'
    case 'task_done':
      return '任务完成'
    case 'step_run':
      return '开始执行一步'
    case 'step_ok':
      return `这一步通过${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_failed':
      return `这一步失败${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_timeout':
      return `这一步超时${ms}`
    case 'replanned':
      return `重新规划${reason !== '' ? `：${reason}` : ''}`
    case 'situation_changed':
      return `情况变了：${reason}`
    default:
      return kind
  }
}
