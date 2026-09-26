import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event, Step, Task } from '@qb/core'
import {
  dropPosition,
  insertionAfter,
  insertionAtEnd,
  isSection,
  movedPosition,
  positionOf,
  type MoveDirection,
  type Position,
} from '@qb/core'
import {
  ApiError,
  api,
  connectEvents,
  type Job,
  type NewStepInput,
  type PartialStep,
  type PurposeStatus,
  type ServerEvent,
  type StepPatchInput,
  type TaskDetail,
} from './api.ts'
import { StepCell, formatMs, type StepActions, type StepRunState } from './StepCell.tsx'
import { Settings } from './Settings.tsx'
import { useHistory } from './history.ts'

/** 大纲里拖拽步骤时 dataTransfer 用的类型。 */
const DRAG_TYPE = 'application/x-qb-step'

interface Toast {
  id: number
  text: string
  tone?: 'error'
  action?: { label: string; run: () => void }
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<'task' | 'settings'>('task')
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [runStates, setRunStates] = useState<Record<string, StepRunState>>({})
  const [focusMode, setFocusMode] = useState(false)
  const [currentStepId, setCurrentStepId] = useState<string | null>(null)
  // QB 的后台任务（起草、看截图、测试连接），按关联实体索引。慢调用不阻塞界面，靠 WS 回报进度。
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  // 起草时流式到达的步骤预览
  const [partials, setPartials] = useState<Record<string, PartialStep[]>>({})
  // 刚插入的步骤：直接进入标题编辑
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [llmStatus, setLlmStatus] = useState<PurposeStatus | null>(null)
  const history = useHistory()

  const detailRef = useRef<TaskDetail | null>(null)
  detailRef.current = detail
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const toast = useCallback((text: string, opts: Omit<Toast, 'id' | 'text'> = {}) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, text, ...opts }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action !== undefined ? 8000 : 5000)
  }, [])

  const refreshTasks = useCallback(async () => {
    setTasks(await api.listTasks())
  }, [])

  const refreshDetail = useCallback(async (taskId: string) => {
    const d = await api.taskDetail(taskId)
    if (activeRef.current !== taskId) return
    setDetail(d)
    // 刷新页面后接回进行中的后台任务
    if (d.jobs.length > 0) setJobs((m) => ({ ...m, ...Object.fromEntries(d.jobs.map((j) => [j.subjectId, j])) }))
  }, [])

  const refreshLlm = useCallback(() => {
    api
      .llmSettings()
      .then((s) => setLlmStatus(s.status.structure))
      .catch(() => setLlmStatus(null))
  }, [])

  useEffect(() => {
    void refreshTasks()
    refreshLlm()
  }, [refreshTasks, refreshLlm])

  useEffect(() => {
    setDetail(null)
    if (activeId === null) return
    void refreshDetail(activeId)
  }, [activeId, refreshDetail])

  // 事件流：步骤输出、完成、编辑、重规划、后台任务
  useEffect(() => {
    const refreshIfActive = (taskId: string): void => {
      if (activeRef.current === taskId) void refreshDetail(taskId)
    }
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
          if (activeRef.current !== null) void refreshDetail(activeRef.current)
          void refreshTasks()
          break

        case 'step.error':
          setRunStates((s) => ({
            ...s,
            [e.stepId]: { ...(s[e.stepId] ?? { output: '' }), running: false, verdict: 'fail', reason: e.message },
          }))
          break

        case 'runbook.updated':
          setPartials((p) => ({ ...p, [e.taskId]: [] }))
          refreshIfActive(e.taskId)
          break

        case 'runbook.changed':
          refreshIfActive(e.taskId)
          break

        case 'job.update':
          setJobs((m) => ({ ...m, [e.job.subjectId]: e.job }))
          break

        case 'job.partial':
          setPartials((p) => ({ ...p, [e.subjectId]: e.steps }))
          break
      }
    },
    // 每次连上（含断线重连）都重拉一次：断线期间的完成/失败事件补不
    // 回来，重拉数据是唯一可靠的恢复方式
    () => {
      void refreshTasks()
      if (activeRef.current !== null) void refreshDetail(activeRef.current)
    })
  }, [refreshDetail, refreshTasks])

  const steps = detail?.steps ?? []
  const runbook = detail?.runbook ?? null

  // 当前步：优先第一个在跑的、再是第一个没做的（章节标题不算），用户点击可覆盖
  const autoCurrent = useMemo(
    () =>
      steps.find((s) => s.status === 'running') ??
      steps.find((s) => s.status === 'pending' && !isSection(s)) ??
      steps.find((s) => !isSection(s)),
    [steps],
  )
  const currentId = currentStepId !== null && steps.some((s) => s.id === currentStepId) ? currentStepId : (autoCurrent?.id ?? null)
  const current = steps.find((s) => s.id === currentId) ?? null

  // ── 编辑动作：每个都记一条撤销，改完刷新 ─────────────────────

  const reload = useCallback(async () => {
    if (activeRef.current !== null) await refreshDetail(activeRef.current)
  }, [refreshDetail])

  /** 带上最新的 rev 执行；冲突（别处先改了）时刷新后再试一次。 */
  const withFreshRev = useCallback(
    async <T,>(stepId: string, fn: (rev: number) => Promise<T>): Promise<T> => {
      const rev = detailRef.current?.steps.find((s) => s.id === stepId)?.rev ?? 0
      try {
        return await fn(rev)
      } catch (e) {
        if (!(e instanceof ApiError) || e.conflict === null) throw e
        await reload()
        return fn(e.conflict.rev)
      }
    },
    [reload],
  )

  const editStep = useCallback(
    async (step: Step, patch: StepPatchInput, record = true): Promise<void> => {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, step[k as keyof Step]])) as StepPatchInput
      try {
        // rev 从最新数据取：快速连改同一步两个字段时，第二次用的是刷新后的 rev，
        // 不会因为自己上一次的修改而 409
        await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, patch))
      } catch (e) {
        if (e instanceof ApiError && e.conflict !== null) {
          await reload()
          throw new Error('这一步刚在别处被改过，已载入最新内容，请再改一次')
        }
        throw e
      }
      if (record) {
        history.push({
          label: `修改「${step.title}」`,
          undo: async () => {
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, before))
            await reload()
          },
          redo: async () => {
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, patch))
            await reload()
          },
        })
      }
      await reload()
    },
    [history, reload, withFreshRev],
  )

  const insertAt = useCallback(
    async (pos: Position, input: NewStepInput = { kind: 'command', title: '新步骤' }): Promise<Step | null> => {
      if (runbook === null) return null
      try {
        const step = await api.insertStep(runbook.id, { ...pos, step: input })
        history.push({
          label: '插入一步',
          undo: async () => {
            await api.deleteStep(step.id)
            await reload()
          },
          redo: async () => {
            await api.restoreStep(step.id)
            await reload()
          },
        })
        setEditTarget(step.id)
        setCurrentStepId(step.id)
        await reload()
        return step
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
        return null
      }
    },
    [runbook, history, reload, toast],
  )

  const removeStep = useCallback(
    async (step: Step): Promise<void> => {
      try {
        await api.deleteStep(step.id)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
        return
      }
      history.push({
        label: `删除「${step.title}」`,
        undo: async () => {
          await api.restoreStep(step.id)
          await reload()
        },
        redo: async () => {
          await api.deleteStep(step.id)
          await reload()
        },
      })
      toast(`已删除「${step.title}」`, {
        action: {
          label: '撤销',
          run: () => {
            void api.restoreStep(step.id).then(reload)
          },
        },
      })
      await reload()
    },
    [history, reload, toast],
  )

  const moveTo = useCallback(
    async (step: Step, to: Position): Promise<void> => {
      const all = detailRef.current?.steps ?? []
      const from = positionOf(all, step)
      if (from.parentId === to.parentId && from.afterId === to.afterId) return
      try {
        await withFreshRev(step.id, (rev) => api.moveStep(step.id, rev, to))
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
        return
      }
      history.push({
        label: `移动「${step.title}」`,
        undo: async () => {
          await withFreshRev(step.id, (rev) => api.moveStep(step.id, rev, from))
          await reload()
        },
        redo: async () => {
          await withFreshRev(step.id, (rev) => api.moveStep(step.id, rev, to))
          await reload()
        },
      })
      await reload()
    },
    [history, reload, toast, withFreshRev],
  )

  const moveStep = useCallback(
    (step: Step, dir: MoveDirection): void => {
      const to = movedPosition(detailRef.current?.steps ?? [], step, dir)
      if (to !== null) void moveTo(step, to)
    },
    [moveTo],
  )

  const setStatus = useCallback(
    async (step: Step, status: 'pending' | 'ok' | 'failed' | 'skipped', note?: string): Promise<void> => {
      const prev = step.status === 'ok' || step.status === 'failed' || step.status === 'skipped' ? step.status : 'pending'
      const prevNote = step.statusNote ?? undefined
      try {
        await api.setStepStatus(step.id, status, note)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
        return
      }
      history.push({
        label: `「${step.title}」的状态`,
        undo: async () => {
          await api.setStepStatus(step.id, prev, prevNote)
          await reload()
        },
        redo: async () => {
          await api.setStepStatus(step.id, status, note)
          await reload()
        },
      })
      await reload()
    },
    [history, reload, toast],
  )

  /** 多行命令拆成多步：第一行留在原步骤，其余依次插在后面。整体一次撤销。 */
  const splitStep = useCallback(
    async (step: Step, lines: string[]): Promise<void> => {
      if (runbook === null || lines.length < 2) return
      const beforeCommand = step.command
      try {
        await editStep(step, { command: lines[0]! }, false)
        const inserted: string[] = []
        let after = step.id
        for (const line of lines.slice(1)) {
          const s = await api.insertStep(runbook.id, {
            parentId: step.parentId,
            afterId: after,
            step: { kind: step.kind === 'note' ? 'command' : step.kind, title: titleFromCommand(line), command: line },
          })
          inserted.push(s.id)
          after = s.id
        }
        history.push({
          label: `拆成 ${lines.length} 步`,
          undo: async () => {
            for (const id of [...inserted].reverse()) await api.deleteStep(id)
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, { command: beforeCommand }))
            await reload()
          },
          redo: async () => {
            for (const id of inserted) await api.restoreStep(id)
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, { command: lines[0]! }))
            await reload()
          },
        })
        toast(`已拆成 ${lines.length} 步`)
        await reload()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      }
    },
    [runbook, editStep, history, reload, toast, withFreshRev],
  )

  const uploadImage = useCallback(
    async (step: Step, file: File): Promise<void> => {
      if (file.size > 5 * 1024 * 1024) {
        toast(`图片太大（${Math.round(file.size / 1024)} KB），上限 5 MB`, { tone: 'error' })
        return
      }
      try {
        const dataUrl = await readAsDataUrl(file)
        const r = await api.submitEvidence(step.id, { imageBase64: dataUrl, mediaType: file.type })
        toast(r.judging ? `截图已贴到「${step.title}」，QB 在看` : `截图已贴到「${step.title}」`)
        await reload()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      }
    },
    [reload, toast],
  )

  const undo = useCallback(async () => {
    try {
      const label = await history.undo()
      if (label !== null) toast(`已撤销：${label}`)
    } catch (e) {
      toast(`撤销失败：${e instanceof Error ? e.message : String(e)}`, { tone: 'error' })
    }
  }, [history, toast])

  const redo = useCallback(async () => {
    try {
      const label = await history.redo()
      if (label !== null) toast(`已重做：${label}`)
    } catch (e) {
      toast(`重做失败：${e instanceof Error ? e.message : String(e)}`, { tone: 'error' })
    }
  }, [history, toast])

  const actionsFor = useCallback(
    (step: Step): StepActions => ({
      edit: (patch) => editStep(step, patch),
      insertAfter: () => void insertAt(insertionAfter(step)),
      remove: () => void removeStep(step),
      move: (dir) => moveStep(step, dir),
      setStatus: (status, note) => void setStatus(step, status, note),
      split: (lines) => void splitStep(step, lines),
      uploadImage: (file) => void uploadImage(step, file),
    }),
    [editStep, insertAt, removeStep, moveStep, setStatus, splitStep, uploadImage],
  )

  // ── 键盘与粘贴 ───────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (view !== 'task' || detail === null) return
      if (isTyping(e.target)) return

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void (e.shiftKey ? redo() : undo())
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        void redo()
        return
      }
      if (e.ctrlKey || e.metaKey) return

      if (e.key === 'f') {
        setFocusMode((v) => !v)
        return
      }
      if (e.key === 'j' || e.key === 'k') {
        const idx = steps.findIndex((s) => s.id === currentId)
        const next = e.key === 'j' ? idx + 1 : idx - 1
        if (next >= 0 && next < steps.length) setCurrentStepId(steps[next]!.id)
        return
      }
      if (e.key === '/' && runbook !== null) {
        e.preventDefault()
        void insertAt(current !== null ? insertionAfter(current) : insertionAtEnd(steps))
        return
      }
      if (current === null) return
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        moveStep(current, e.key === 'ArrowUp' ? 'up' : 'down')
      } else if (e.key === 'Tab') {
        e.preventDefault()
        moveStep(current, e.shiftKey ? 'outdent' : 'indent')
      } else if (e.key === 'Delete') {
        e.preventDefault()
        void removeStep(current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, detail, steps, current, currentId, runbook, undo, redo, insertAt, moveStep, removeStep])

  // 截图直接 Ctrl+V：贴到当前步。不需要先找输入框。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (view !== 'task' || current === null || isSection(current)) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (file === undefined) return
      e.preventDefault()
      void uploadImage(current, file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [view, current, uploadImage])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">QB</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost"
            title="新任务"
            onClick={() => {
              setView('task')
              setActiveId(null)
            }}
          >
            ＋
          </button>
        </div>
        <div className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={`task-item${t.id === activeId && view === 'task' ? ' active' : ''}`}
              onClick={() => {
                setView('task')
                setActiveId(t.id)
                setCurrentStepId(null)
              }}
            >
              <span className={`gem ${gemClass(t)}`}>{gem(t)}</span>
              <span className="title">{t.title}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className={`btn ghost${view === 'settings' ? ' on' : ''}`} onClick={() => setView('settings')}>
            ⚙ 设置
          </button>
          {llmStatus !== null && !llmStatus.ok && (
            <span className="verdict unclear" style={{ fontSize: 12 }}>
              还没配置模型
            </span>
          )}
        </div>
      </aside>

      {view === 'settings' ? (
        <Settings jobs={jobs} />
      ) : activeId === null ? (
        <NewTask
          onCreated={async (task) => {
            await refreshTasks()
            setActiveId(task.id)
          }}
        />
      ) : detail === null ? (
        <div className="empty-state">读取中…</div>
      ) : (
        <TaskPage
          detail={detail}
          jobs={jobs}
          partial={partials[detail.task.id] ?? []}
          llmStatus={llmStatus}
          runStates={runStates}
          currentId={currentId}
          editTarget={editTarget}
          focusMode={focusMode}
          actionsFor={actionsFor}
          onToggleFocus={() => setFocusMode((v) => !v)}
          onSelectStep={(id) => {
            setCurrentStepId(id)
            if (id !== editTarget) setEditTarget(null)
          }}
          onInsert={(pos) => void insertAt(pos)}
          onDrop={(dragged, target) => void moveTo(dragged, dropPosition(steps, target, dragged))}
          onChanged={() => void reload()}
          onOpenSettings={() => setView('settings')}
          toast={toast}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'error' ? ' error' : ''}`}>
            <span>{t.text}</span>
            {t.action !== undefined && (
              <button
                className="btn ghost"
                onClick={() => {
                  t.action!.run()
                  setToasts((all) => all.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 任务页 ────────────────────────────────────────────────────

interface TaskPageProps {
  detail: TaskDetail
  jobs: Record<string, Job>
  partial: PartialStep[]
  llmStatus: PurposeStatus | null
  runStates: Record<string, StepRunState>
  currentId: string | null
  editTarget: string | null
  focusMode: boolean
  actionsFor: (step: Step) => StepActions
  onToggleFocus: () => void
  onSelectStep: (id: string) => void
  onInsert: (pos: Position) => void
  onDrop: (dragged: Step, target: Step) => void
  onChanged: () => void
  onOpenSettings: () => void
  toast: (text: string, opts?: Omit<Toast, 'id' | 'text'>) => void
}

function TaskPage({
  detail,
  jobs,
  partial,
  llmStatus,
  runStates,
  currentId,
  editTarget,
  focusMode,
  actionsFor,
  onToggleFocus,
  onSelectStep,
  onInsert,
  onDrop,
  onChanged,
  onOpenSettings,
  toast,
}: TaskPageProps) {
  const { task, runbook, steps } = detail
  const currentRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentId])

  const real = steps.filter((s) => !isSection(s))
  const done = real.filter((s) => s.status === 'ok' || s.status === 'skipped').length
  const visible = focusMode ? steps.filter((s) => s.id === currentId) : steps
  const draftJob = jobs[task.id]?.kind === 'draft' ? jobs[task.id] : undefined

  // 每一步最近一次内容编辑：悬停"我改的"时显示改前改后
  const lastEdits = useMemo(() => {
    const m: Record<string, Event> = {}
    for (const e of detail.events) if (e.kind === 'edit' && e.stepId !== null) m[e.stepId] = e
    return m
  }, [detail.events])

  const canMoveOf = (s: Step): Record<MoveDirection, boolean> => ({
    up: movedPosition(steps, s, 'up') !== null,
    down: movedPosition(steps, s, 'down') !== null,
    indent: movedPosition(steps, s, 'indent') !== null,
    outdent: movedPosition(steps, s, 'outdent') !== null,
  })

  const current = steps.find((s) => s.id === currentId) ?? null

  return (
    <div className="task-page">
      <header className="task-header">
        <h1>{task.title}</h1>
        <span className="task-meta">
          <span className={`gem ${gemClass(task)}`}>{gem(task)}</span> {statusLabel(task)} · {done}/{real.length}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
        </span>
        <span className="spacer" />
        <span className="task-meta keys" title="快捷键">
          / 插入 · Alt+↑↓ 移动 · Tab 进出章节 · Delete 删除 · Ctrl+Z 撤销
        </span>
        <button className="btn ghost" onClick={onToggleFocus}>
          {focusMode ? '退出专注 (f)' : '专注模式 (f)'}
        </button>
      </header>

      <div className={`task-body${focusMode ? ' focus-mode' : ''}`}>
        <nav className="outline">
          {steps.map((s) => (
            <button
              key={s.id}
              draggable
              onDragStart={(e) => {
                // 被拖的是哪一步放在 dataTransfer 里：drop 时不依赖 React 状态是否已刷新
                e.dataTransfer.setData(DRAG_TYPE, s.id)
                e.dataTransfer.effectAllowed = 'move'
                setDragId(s.id)
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData(DRAG_TYPE)
                setDragId(null)
                const dragged = steps.find((x) => x.id === id)
                if (dragged !== undefined && dragged.id !== s.id) onDrop(dragged, s)
              }}
              className={`outline-item${s.id === currentId ? ' current' : ''}${s.parentId !== null ? ' depth-1' : ''}${
                isSection(s) ? ' section' : ''
              }${dragId === s.id ? ' dragging' : ''}`}
              onClick={() => onSelectStep(s.id)}
            >
              <span>{isSection(s) ? '§' : outlineMark(s)}</span>
              <span className="t">{s.title}</span>
            </button>
          ))}
        </nav>

        <main className="runbook">
          {/* 重新起草也流式显示：不用等整份写完才知道 QB 在写什么 */}
          {draftJob?.status === 'running' && steps.length > 0 && (
            <div className="redrafting">
              <p style={{ color: 'var(--text-dim)', margin: '0 0 6px' }}>
                QB 正在重新起草……{draftJob.progress ?? ''}（现在的 runbook 仍在，替换前会留快照）
              </p>
              {partial.map((s, i) => (
                <div className="ghost-step" key={i}>
                  {(i === 0 || partial[i - 1]!.section !== s.section) && s.section !== '' && (
                    <div className="ghost-section">{s.section}</div>
                  )}
                  <div className="ghost-title">○ {s.title}</div>
                  {s.command !== undefined && <pre className="ghost-cmd">{s.command}</pre>}
                </div>
              ))}
            </div>
          )}

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

          {steps.length === 0 && (
            <DraftPrompt taskId={task.id} job={draftJob} partial={partial} llmStatus={llmStatus} onOpenSettings={onOpenSettings} />
          )}

          {visible.map((s) => (
            <div key={s.id} ref={s.id === currentId ? currentRef : undefined}>
              <StepCell
                step={s}
                current={s.id === currentId}
                runState={runStates[s.id]}
                evidence={detail.evidence[s.id] ?? []}
                job={jobs[s.id]}
                lastEdit={lastEdits[s.id]}
                autoEdit={s.id === editTarget}
                canMove={canMoveOf(s)}
                actions={actionsFor(s)}
                onFocus={() => onSelectStep(s.id)}
                onChanged={onChanged}
              />
              {!focusMode && <InsertBar onClick={() => onInsert(insertionAfter(s))} />}
            </div>
          ))}

          {runbook !== null && steps.length > 0 && !focusMode && (
            <button className="btn ghost add-step" onClick={() => onInsert(insertionAtEnd(steps))}>
              ＋ 添加一步
            </button>
          )}
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
                    {eventText(e, steps)}
                    <div className="when">{new Date(e.createdAt).toLocaleTimeString('zh-CN')}</div>
                  </div>
                ))
            )}
          </div>
          <div className="qb-actions">
            {/* 临时 · 复制到 IM 替代：M8 接上团队服务后改为直接发给发起人、回答内联出现在这一步 */}
            <button
              className="btn"
              title="临时方案：整理好求助内容复制到剪贴板，你贴到 IM 里发给发起人"
              onClick={() => {
                void navigator.clipboard.writeText(
                  askText(
                    task,
                    current,
                    current !== null ? (detail.evidence[current.id] ?? []) : [],
                    current !== null ? detail.events : [],
                  ),
                )
                toast('求助内容已复制，贴到 IM 里发给发起人（临时 · 复制到 IM）')
              }}
            >
              问发起人（临时 · 复制到 IM）
            </button>
            {steps.length > 0 && <RedraftButton taskId={task.id} job={draftJob} />}
          </div>
        </aside>
      </div>
    </div>
  )
}

/** 单元之间的插入条：悬停时出现"＋"。 */
function InsertBar({ onClick }: { onClick: () => void }) {
  return (
    <div className="insert-bar" onClick={onClick} title="在这里插入一步（/）">
      <span>＋</span>
    </div>
  )
}

// ── 起草 ──────────────────────────────────────────────────────

/** 起草期间显示已等待时长。干等一个不知道要多久的转圈是最烦人的。 */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  return since === null ? 0 : Math.floor((now - since) / 1000)
}

/**
 * 空 runbook 时的起草入口（兜底路径：QB 的猜测，整份标为"QB 写的"）。
 *
 * 起草在后台跑，步骤边写边经 WS 推过来——首步通常几秒内就出现。
 * 用户切走再回来、刷新页面都能接回进度。
 */
function DraftPrompt({
  taskId,
  job,
  partial,
  llmStatus,
  onOpenSettings,
}: {
  taskId: string
  job: Job | undefined
  partial: PartialStep[]
  llmStatus: PurposeStatus | null
  onOpenSettings: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const running = job?.status === 'running'
  const elapsed = useElapsed(running ? job!.startedAt : null)

  const start = (): void => {
    setError(null)
    api.draft(taskId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  if (running) {
    return (
      <div>
        <p style={{ color: 'var(--text-dim)' }}>
          QB 正在起草……{job!.progress ?? '检索团队的 skill 和坑'} · 已等待 {elapsed} 秒
        </p>
        {partial.map((s, i) => (
          <div className="ghost-step" key={i}>
            {(i === 0 || partial[i - 1]!.section !== s.section) && s.section !== '' && (
              <div className="ghost-section">{s.section}</div>
            )}
            <div className="ghost-title">○ {s.title}</div>
            {s.command !== undefined && <pre className="ghost-cmd">{s.command}</pre>}
          </div>
        ))}
      </div>
    )
  }

  const failure = error ?? (job?.status === 'failed' ? job.error : null)
  const unconfigured = llmStatus !== null && !llmStatus.ok

  return (
    <div style={{ color: 'var(--text-dim)' }}>
      <p>还没有 runbook。</p>
      {unconfigured ? (
        <p>
          还没有配置模型。{' '}
          <button className="btn primary" onClick={onOpenSettings}>
            去设置
          </button>
        </p>
      ) : (
        <>
          <button className="btn primary" onClick={start}>
            让 QB 起草
          </button>
          <p className="paste-hint">QB 起草的是猜测，每条命令都会标成"QB 写的"，请逐条核对、直接改。</p>
        </>
      )}
      {failure !== null && (
        <p className="verdict fail" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
          {failure}
        </p>
      )}
    </div>
  )
}

/** 重新起草。旧版本会保留，不会丢。 */
function RedraftButton({ taskId, job }: { taskId: string; job: Job | undefined }) {
  const [error, setError] = useState<string | null>(null)
  const running = job?.status === 'running'
  const elapsed = useElapsed(running ? job!.startedAt : null)

  return (
    <>
      <button
        className="btn ghost"
        disabled={running}
        onClick={() => {
          setError(null)
          api.draft(taskId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        }}
      >
        {running ? `${job!.progress ?? 'QB 起草中'} · ${elapsed}s` : '让 QB 重新起草'}
      </button>
      {(error ?? (job?.status === 'failed' ? job.error : null)) !== null && (
        <div className="verdict fail" style={{ fontSize: 12 }}>
          {error ?? job?.error}
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

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('读不了这张图片'))
    r.readAsDataURL(file)
  })
}

/** 拆出来的步骤先用命令本身当标题（去掉环境变量前缀），用户随手改。 */
function titleFromCommand(line: string): string {
  const core = line.replace(/^(\w+=\S+\s+)+/, '').replace(/^nohup\s+/, '')
  return core.length > 48 ? `${core.slice(0, 48)}…` : core
}

/**
 * 求助文本（临时 · 复制到 IM）：目标、卡在哪一步、命令、输出尾部、
 * 已经试过什么。发起人不用追问上下文就能回答。
 */
function askText(
  task: Task,
  step: Step | null,
  evidence: Array<{ text: string | null; imagePath: string | null }>,
  events: Event[],
): string {
  const lines = [`【求助】${task.title}`]
  if (step !== null) {
    lines.push(`卡在：${step.title}${step.statusNote !== null ? `（${step.statusNote}）` : ''}`)
    if (step.command !== null) lines.push(`命令：${step.command}`)
    const last = [...evidence].reverse().find((e) => e.text !== null)
    if (last?.text != null) {
      const tail = last.text.trim().split('\n').slice(-15).join('\n')
      lines.push(`现象（输出尾部）：\n${tail}`)
    }
    if (evidence.some((e) => e.imagePath !== null)) lines.push('（我这边还有截图，需要的话发你）')

    // 已经试过什么：最近在这条步骤上的失败、超时和改动
    const tried = events
      .filter((e) => e.stepId === step.id && (e.kind === 'step_failed' || e.kind === 'step_timeout' || e.kind === 'edit'))
      .slice(-3)
      .map((e) => {
        if (e.kind === 'step_timeout') return '等到超时'
        if (e.kind === 'step_failed') {
          const r = typeof e.payload.reason === 'string' && e.payload.reason !== '' ? `（${e.payload.reason}）` : ''
          return `失败${r}`
        }
        const changes = Array.isArray(e.payload.changes) ? (e.payload.changes as Array<{ field: string }>) : []
        return changes.some((c) => c.field === 'command') ? '改过命令' : '改过这步'
      })
    lines.push(`我试过：${tried.length > 0 ? tried.join('；') : '（还没试过别的办法）'}`)
  }
  lines.push('—— QB 整理')
  return lines.join('\n')
}

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

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  whyMd: '为什么',
  command: '命令',
  expectation: '预期',
  expectedMinutes: '预计耗时',
  kind: '类型',
  status: '状态',
}

function eventText(e: Event, steps: Step[]): string {
  const payload = e.payload
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  const ms = typeof payload.durationMs === 'number' ? ` (${formatMs(payload.durationMs)})` : ''
  const title =
    typeof payload.title === 'string' ? payload.title : (steps.find((s) => s.id === e.stepId)?.title ?? '')
  const which = title !== '' ? `「${title}」` : '这一步'
  const byQb = payload.by === 'qb'

  switch (e.kind) {
    case 'task_started':
      return '任务开始'
    case 'task_done':
      return '任务完成'
    case 'step_run':
      return `开始执行${which}`
    case 'step_ok':
      return payload.source === 'image' && byQb
        ? `QB 看了截图：${which}通过${reason !== '' ? ` — ${reason}` : ''}`
        : `${which}通过${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_failed':
      if (typeof payload.diagnosis === 'string') return `QB 诊断${which}：${payload.diagnosis}`
      return payload.source === 'image' && byQb
        ? `QB 看了截图：${which}没通过${reason !== '' ? ` — ${reason}` : ''}`
        : `${which}失败${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_timeout':
      return `${which}超时${ms}`
    case 'step_skipped':
      return `跳过了${which}${reason !== '' ? `：${reason}` : ''}`
    case 'edit': {
      const changes = Array.isArray(payload.changes) ? (payload.changes as Array<{ field: string }>) : []
      const fields = [...new Set(changes.map((c) => FIELD_LABEL[c.field] ?? c.field).filter((f) => f !== '超时'))]
      return `改了${which}的${fields.join('、') || '内容'}`
    }
    case 'insert':
      return `插入一步${which}`
    case 'reorder':
      return `调整了${which}的位置`
    case 'step_deleted':
      return `删除了${which}`
    case 'step_restored':
      return `恢复了${which}`
    case 'replanned': {
      const dropped = typeof payload.dropped === 'number' && payload.dropped > 0 ? `（${payload.dropped} 个步骤不合格式被丢弃）` : ''
      return `${byQb ? 'QB ' : ''}${reason !== '' ? reason : '重新规划'}${dropped}`
    }
    case 'situation_changed':
      return `情况变了：${reason}`
    default:
      return e.kind
  }
}
