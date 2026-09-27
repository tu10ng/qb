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
  type AdaptProposal,
  type BaseSuggestion,
  type Job,
  type LessonOfferView,
  type LessonView,
  type NewStepInput,
  type PartialStep,
  type PurposeStatus,
  type ServerEvent,
  type StepPatchInput,
  type SyncStatus,
  type TaskDetail,
  type TeamUser,
} from './api.ts'
import { StepCell, formatMs, type StepActions, type StepRunState } from './StepCell.tsx'
import { Settings } from './Settings.tsx'
import { ParamsPanel } from './ParamsPanel.tsx'
import { AdaptCard } from './AdaptCard.tsx'
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
  // wait 步骤"盯着"时每一步最近一次探测（step.probe）
  const [probes, setProbes] = useState<Record<string, { attempt: number; detail: string }>>({})
  const [currentStepId, setCurrentStepId] = useState<string | null>(null)
  // 窄屏（和终端并排）时侧栏收成抽屉
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // QB 的后台任务（起草、看截图、测试连接），按关联实体索引。慢调用不阻塞界面，靠 WS 回报进度。
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  // 起草时流式到达的步骤预览
  const [partials, setPartials] = useState<Record<string, PartialStep[]>>({})
  // 刚插入的步骤：直接进入标题编辑
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [llmStatus, setLlmStatus] = useState<PurposeStatus | null>(null)
  const [teamEnabled, setTeamEnabled] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  // 坑（M9）：步骤 → 两层坑；待确认的捕获提议
  const [stepLessons, setStepLessons] = useState<Record<string, { layer1: LessonView[]; layer2: LessonView[] }>>({})
  const [lessonOffers, setLessonOffers] = useState<LessonOfferView[]>([])
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
    // 坑（M9）：分层显示与捕获提议跟 detail 一起刷；失败不影响主界面
    void api
      .stepLessons(taskId)
      .then((steps) => {
        if (activeRef.current === taskId) setStepLessons(steps)
      })
      .catch(() => undefined)
    void api
      .lessonOffers(taskId)
      .then((offers) => {
        if (activeRef.current === taskId) setLessonOffers(offers)
      })
      .catch(() => undefined)
    // 刷新页面后接回进行中的后台任务
    if (d.jobs.length > 0) setJobs((m) => ({ ...m, ...Object.fromEntries(d.jobs.map((j) => [j.subjectId, j])) }))
  }, [])

  const refreshLlm = useCallback(() => {
    api
      .llmSettings()
      .then((s) => setLlmStatus(s.status.structure))
      .catch(() => setLlmStatus(null))
    api
      .teamSettings()
      .then((t) => {
        setTeamEnabled(t.enabled)
        setSyncStatus(t.enabled ? t.status : null)
        if (!t.enabled) return
        // 团队里的人：选发起人、委派给谁都从这里挑（原先手打名字，打错了对方永远收不到）
        api
          .teamUsers()
          .then((r) => setTeamUsers(r.users))
          .catch(() => undefined)
      })
      .catch(() => setTeamEnabled(false))
  }, [])

  useEffect(() => {
    void refreshTasks()
    refreshLlm()
  }, [refreshTasks, refreshLlm])

  // 设置页改完团队配置回来要刷新（简单起见：每次切回任务视图都刷一次）
  useEffect(() => {
    if (view === 'task') refreshLlm()
  }, [view, refreshLlm])

  // 同步状态是真实的：推送失败（令牌、身份、网络）会显示出来，不再无条件"同步中"
  useEffect(() => {
    if (!teamEnabled) return
    const t = setInterval(() => {
      api
        .teamSettings()
        .then((s) => setSyncStatus(s.enabled ? s.status : null))
        .catch(() => undefined)
    }, 10_000)
    return () => clearInterval(t)
  }, [teamEnabled])

  useEffect(() => {
    setDetail(null)
    setStepLessons({})
    setLessonOffers([])
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

        case 'step.probe':
          setProbes((p) => ({ ...p, [e.stepId]: { attempt: e.attempt, detail: e.detail } }))
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

  // 当前步：优先第一个在跑的、再是第一个没做的（章节标题不算），用户点击可覆盖。
  // QB 在盯着的 wait 步骤、交给别人的委派步骤不占"当前"——"我盯着，你先看下一步"
  const autoCurrent = useMemo(
    () =>
      steps.find((s) => s.status === 'running' && s.kind !== 'wait' && s.kind !== 'delegate') ??
      steps.find((s) => s.status === 'pending' && !isSection(s)) ??
      steps.find((s) => s.status === 'running') ??
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

  /** 委派：经团队服务派给对方，这一步变成委派行（引擎一次做完，派不出去就什么都不改）。 */
  const delegateStep = useCallback(
    async (step: Step, input: { assigneeName: string; displayName?: string; note?: string }): Promise<void> => {
      try {
        await api.delegateStep(step.id, input)
        toast(`已委派给${input.displayName ?? input.assigneeName}：对方几秒内收到，进度会出现在这一步上`)
        await reload()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      }
    },
    [reload, toast],
  )

  /** 命令里写了却没声明的参数：一键加进参数表（值先空着，运行前填）。 */
  const declareParams = useCallback(
    async (names: string[]): Promise<void> => {
      const d = detailRef.current
      if (d === null || d.runbook === null) return
      const have = new Set(d.runbook.params.map((p) => p.name))
      const next = [...d.runbook.params, ...names.filter((n) => !have.has(n)).map((name) => ({ name, value: '', source: 'mine' as const, secret: false }))]
      try {
        await api.updateParams(d.task.id, next)
        toast(`已声明 ${names.join('、')}，在参数面板里填上值就能运行`)
        await reload()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      }
    },
    [reload, toast],
  )

  const actionsFor = useCallback(
    (step: Step): StepActions => ({
      edit: (patch) => editStep(step, patch),
      insertAfter: () => void insertAt(insertionAfter(step)),
      remove: () => void removeStep(step),
      move: (dir) => moveStep(step, dir),
      setStatus: (status, note) => void setStatus(step, status, note),
      split: (lines) => void splitStep(step, lines),
      uploadImage: (file) => void uploadImage(step, file),
      delegate: (input) => delegateStep(step, input),
      declareParams: (names) => void declareParams(names),
    }),
    [editStep, insertAt, removeStep, moveStep, setStatus, splitStep, uploadImage, delegateStep, declareParams],
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

  const openTask = (id: string): void => {
    setView('task')
    setActiveId(id)
    setCurrentStepId(null)
    setSidebarOpen(false)
  }
  const ongoing = tasks.filter((t) => t.status !== 'done' && t.status !== 'abandoned')
  const finished = tasks.filter((t) => t.status === 'done' || t.status === 'abandoned')

  return (
    <div className="app">
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-head">
          <span className="brand">QB</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost"
            title="新任务"
            onClick={() => {
              setView('task')
              setActiveId(null)
              setSidebarOpen(false)
            }}
          >
            ＋
          </button>
          <button className="btn ghost drawer-close" title="收起" onClick={() => setSidebarOpen(false)}>
            ✕
          </button>
        </div>
        <div className="task-list">
          {ongoing.map((t) => (
            <TaskItem key={t.id} task={t} active={t.id === activeId && view === 'task'} onOpen={() => openTask(t.id)} />
          ))}
          {ongoing.length === 0 && <p className="dim" style={{ padding: '6px 9px' }}>没有进行中的任务。</p>}
          {finished.length > 0 && <FinishedTasks tasks={finished} activeId={view === 'task' ? activeId : null} onOpen={openTask} />}
        </div>
        <div className="sidebar-foot">
          <button className={`btn ghost${view === 'settings' ? ' on' : ''}`} onClick={() => { setView('settings'); setSidebarOpen(false) }}>
            ⚙ 设置
          </button>
          {llmStatus !== null && !llmStatus.ok && (
            <span className="verdict unclear" style={{ fontSize: 12 }}>
              还没配置模型
            </span>
          )}
          {teamEnabled && syncStatus !== null && (
            <span
              className={`verdict ${syncStatus.ok === false ? 'fail' : 'pass'}`}
              style={{ fontSize: 12 }}
              title={syncStatus.detail}
            >
              {syncStatus.ok === false ? `团队同步失败：${syncStatus.detail}` : syncStatus.ok === true ? '团队：已同步' : '团队：连接中…'}
            </span>
          )}
        </div>
      </aside>

      {view === 'settings' ? (
        <Settings jobs={jobs} />
      ) : activeId === null ? (
        <NewTask
          teamUsers={teamUsers}
          teamEnabled={teamEnabled}
          onOpenNav={() => setSidebarOpen(true)}
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
          probes={probes}
          currentId={currentId}
          editTarget={editTarget}
          actionsFor={actionsFor}
          onSelectStep={(id) => {
            setCurrentStepId(id)
            if (id !== editTarget) setEditTarget(null)
          }}
          onInsert={(pos) => void insertAt(pos)}
          onDrop={(dragged, target) => void moveTo(dragged, dropPosition(steps, target, dragged))}
          onChanged={() => {
            void reload()
            void refreshTasks()
          }}
          onOpenSettings={() => setView('settings')}
          onOpenNav={() => setSidebarOpen(true)}
          teamEnabled={teamEnabled}
          teamUsers={teamUsers}
          toast={toast}
          lessons={stepLessons}
          offers={lessonOffers}
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
  /** wait 步骤"盯着"时每一步最近一次探测。 */
  probes: Record<string, { attempt: number; detail: string }>
  currentId: string | null
  editTarget: string | null
  actionsFor: (step: Step) => StepActions
  onSelectStep: (id: string) => void
  onInsert: (pos: Position) => void
  onDrop: (dragged: Step, target: Step) => void
  onChanged: () => void
  onOpenSettings: () => void
  /** 窄屏：打开任务列表抽屉。 */
  onOpenNav: () => void
  /** 配好团队服务时"问发起人"走真实发送。 */
  teamEnabled: boolean
  teamUsers: TeamUser[]
  toast: (text: string, opts?: Omit<Toast, 'id' | 'text'>) => void
  /** M9：步骤 → 两层坑；待确认提议。 */
  lessons: Record<string, { layer1: LessonView[]; layer2: LessonView[] }>
  offers: LessonOfferView[]
}

function TaskPage({
  detail,
  jobs,
  partial,
  llmStatus,
  runStates,
  probes,
  currentId,
  editTarget,
  actionsFor,
  onSelectStep,
  onInsert,
  onDrop,
  onChanged,
  onOpenSettings,
  onOpenNav,
  teamEnabled,
  teamUsers,
  toast,
  lessons,
  offers,
}: TaskPageProps) {
  const { task, runbook, steps } = detail
  const currentRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // 差异卡片：job 一次一换 id，按 id 记住"先不用"
  const [adaptDismissedJob, setAdaptDismissedJob] = useState<string | null>(null)
  const [situationOpen, setSituationOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [retroOpen, setRetroOpen] = useState(false)
  const [blockedOpen, setBlockedOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // 窄屏（和 SecureCRT 并排）时大纲与 QB 面板收成抽屉
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentId])

  const real = steps.filter((s) => !isSection(s))
  const done = real.filter((s) => s.status === 'ok' || s.status === 'skipped').length
  const ended = task.status === 'done' || task.status === 'abandoned'
  // 每一步都做完了（或跳过），任务却还没完成：提示一句，完成即复盘
  const allDone = real.length > 0 && done === real.length && !ended
  const startJob = jobs[task.id]
  const draftJob = startJob?.kind === 'draft' ? startJob : undefined
  const importJob = startJob?.kind === 'import' ? startJob : undefined
  const adaptJob = startJob?.kind === 'adapt' ? startJob : undefined
  const adaptProposal =
    adaptJob?.status === 'done' ? (adaptJob.result as AdaptProposal | null) : null
  const showAdapt = adaptProposal !== null && adaptDismissedJob !== adaptJob!.id
  const params = runbook?.params ?? []
  const fidelityByStep = new Map((detail.fidelity?.items ?? []).map((i) => [i.stepId, i]))

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

  // 每一步上的评论（发起人在远程界面针对某一步说的）
  const commentsByStep = useMemo(() => {
    const m: Record<string, Event[]> = {}
    for (const e of detail.events) if (e.kind === 'comment' && e.stepId !== null) (m[e.stepId] ??= []).push(e)
    return m
  }, [detail.events])

  const setStatus = (status: 'active' | 'blocked' | 'done' | 'abandoned', note?: string): void => {
    api
      .setTaskStatus(task.id, status, note)
      .then(() => {
        onChanged()
        if (status === 'done') {
          toast('任务完成了——看看这次有什么值得记下来的')
          setRetroOpen(true)
        } else if (status === 'blocked') {
          toast(teamEnabled ? 'QB 会替你告诉发起人（带上原因）' : '已标记卡住（没配团队服务，发起人收不到）')
        }
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
  }

  return (
    <div className="task-page">
      <header className="task-header">
        <button className="btn ghost nav-toggle" title="任务列表" onClick={onOpenNav}>
          ☰
        </button>
        <h1>{task.title}</h1>
        <span className="task-meta">
          <span className={`gem ${gemClass(task)}`}>{gem(task)}</span> {statusLabel(task)} · {done}/{real.length}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
        </span>
        <span className="spacer" />
        <span className="task-meta keys" title="快捷键">
          / 插入 · Alt+↑↓ 移动 · Tab 进出章节 · Delete 删除 · Ctrl+Z 撤销
        </span>
        <div className="header-actions">
          <button className="btn ghost outline-toggle" onClick={() => setOutlineOpen((v) => !v)}>
            大纲
          </button>
          {!ended && (
            <>
              <button
                className="btn"
                title={teamEnabled ? 'QB 整理好求助发给发起人，回答会回到这一步' : '临时方案：整理好求助内容复制到剪贴板，你贴到 IM 里发给发起人'}
                onClick={() => setAskOpen(true)}
              >
                问发起人{teamEnabled ? '' : '（复制到 IM）'}
              </button>
              {steps.length > 0 && (
                <>
                  <button className="btn" onClick={() => setSituationOpen(true)}>
                    情况变了…
                  </button>
                  <button className="btn" onClick={() => setTranscriptOpen(true)} title="自己在外部终端里跑了几步？把整段输出贴进来，QB 按命令分回各步">
                    贴终端记录
                  </button>
                </>
              )}
              {task.status === 'blocked' ? (
                <button className="btn danger" title="不卡了，继续做" onClick={() => setStatus('active')}>
                  继续
                </button>
              ) : (
                <button className="btn" title="卡住了、在等别人：QB 会替你告诉发起人" onClick={() => setBlockedOpen(true)}>
                  卡住了
                </button>
              )}
              <button className={`btn${allDone ? ' primary' : ''}`} onClick={() => setStatus('done')}>
                完成任务
              </button>
            </>
          )}
          {(ended || offers.length > 0) && (
            <button className="btn ghost" onClick={() => setRetroOpen(true)}>
              复盘{offers.length > 0 ? `（${offers.length}）` : ''}
            </button>
          )}
          <span className="more">
            <button className="btn ghost" title="更多" onClick={() => setMoreOpen((v) => !v)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="menu" onMouseLeave={() => setMoreOpen(false)}>
                {steps.length > 0 && !ended && <RedraftButton taskId={task.id} job={draftJob} asMenuItem />}
                {!ended && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMoreOpen(false)
                      const why = window.prompt('放弃这个任务？可以写一句原因（发起人会看到）', '')
                      if (why !== null) setStatus('abandoned', why)
                    }}
                  >
                    放弃这个任务
                  </button>
                )}
                {ended && (
                  <button className="menu-item" onClick={() => { setMoreOpen(false); setStatus('active') }}>
                    重新打开
                  </button>
                )}
                <button className="menu-item panel-toggle" onClick={() => { setMoreOpen(false); setPanelOpen(true) }}>
                  看 QB 时间线
                </button>
              </div>
            )}
          </span>
        </div>
      </header>

      <div className="task-body">
        <nav className={`outline${outlineOpen ? ' open' : ''}`} onClick={() => setOutlineOpen(false)}>
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
              <span title={lessons[s.id] !== undefined ? '这一步有坑记录' : undefined}>
                {isSection(s) ? '§' : outlineMark(s)}
                {!isSection(s) && lessons[s.id] !== undefined && <span className="lesson-dot">⚠</span>}
              </span>
              <span className="t">{s.title}</span>
            </button>
          ))}
        </nav>

        <main className="runbook">
          {/* 重新起草 / 导入也流式显示：不用等整份写完才知道 QB 在写什么 */}
          {(draftJob?.status === 'running' || importJob?.status === 'running') && steps.length > 0 && (
            <div className="redrafting">
              <p style={{ color: 'var(--text-dim)', margin: '0 0 6px' }}>
                {importJob !== undefined ? 'QB 正在从素材整理' : 'QB 正在重新起草'}
                ……{(importJob ?? draftJob)!.progress ?? ''}（现在的 runbook 仍在，替换前会留快照）
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

          {/* 差异卡片：模式 A 的逐项接受 / 情况变了的重规划。
              key 绑 job id：新一次出差异时勾选状态重置，不沿用上一份的 */}
          {showAdapt && adaptProposal !== null && (
            <AdaptCard
              key={adaptJob!.id}
              taskId={task.id}
              steps={steps}
              params={params}
              runbookVersion={runbook?.version ?? 1}
              proposal={adaptProposal}
              onApplied={() => {
                setAdaptDismissedJob(adaptJob!.id)
                onChanged()
              }}
              onDismiss={() => setAdaptDismissedJob(adaptJob!.id)}
              toast={toast}
            />
          )}

          {task.status === 'blocked' && (
            <div className="banner danger">
              {blockedNote(detail.events)}
              {teamEnabled ? ' · QB 已替你告诉发起人。' : ' · 没配团队服务，发起人收不到——可以用"问发起人"复制求助发给他。'}
              <button className="btn ghost" onClick={() => setStatus('active')}>
                不卡了，继续
              </button>
            </div>
          )}

          {allDone && (
            <div className="banner">
              每一步都做完了。
              <button className="btn primary" onClick={() => setStatus('done')}>
                完成任务并复盘
              </button>
            </div>
          )}

          {ended && (
            <div className="banner">
              {task.status === 'done' ? '这个任务已经完成。' : '这个任务已经放弃。'}
              <button className="btn ghost" onClick={() => setRetroOpen(true)}>
                复盘
              </button>
              <button className="btn ghost" onClick={() => setStatus('active')}>
                重新打开
              </button>
            </div>
          )}

          {runbook !== null && <ParamsPanel taskId={task.id} params={params} onChanged={onChanged} toast={toast} />}

          {/* 导入来的 runbook：保真概况一行（参数一改会跟着变） */}
          {detail.fidelity !== null && (
            <div className="fidelity-strip">
              来自素材：{detail.fidelity.items.filter((i) => i.verbatim).length}/{detail.fidelity.items.length} 条命令逐字 ·{' '}
              {detail.fidelity.items.filter((i) => !i.verbatim && !i.unverified).length} 条 QB 改写过 ·{' '}
              素材里 {detail.fidelity.uncoveredCount} 行命令没用上
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
            <DraftPrompt
              taskId={task.id}
              title={task.title}
              brief={task.briefMd}
              job={importJob ?? draftJob}
              partial={partial}
              llmStatus={llmStatus}
              material={detail.material}
              onOpenSettings={onOpenSettings}
              onChanged={onChanged}
              toast={toast}
            />
          )}

          {steps.map((s) => (
            <div key={s.id} ref={s.id === currentId ? currentRef : undefined}>
              <StepCell
                step={s}
                current={s.id === currentId}
                runState={runStates[s.id]}
                evidence={detail.evidence[s.id] ?? []}
                params={params}
                fidelity={fidelityByStep.get(s.id)}
                job={jobs[s.id]}
                lastEdit={lastEdits[s.id]}
                autoEdit={s.id === editTarget}
                canMove={canMoveOf(s)}
                lessons={lessons[s.id]}
                offers={offers.filter((o) => o.stepId === s.id)}
                comments={commentsByStep[s.id]}
                delegation={detail.delegations[s.id]}
                probe={probes[s.id]}
                teamUsers={teamUsers}
                teamEnabled={teamEnabled}
                actions={actionsFor(s)}
                onFocus={() => onSelectStep(s.id)}
                onChanged={onChanged}
              />
              <InsertBar onClick={() => onInsert(insertionAfter(s))} />
            </div>
          ))}

          {runbook !== null && steps.length > 0 && (
            <button className="btn ghost add-step" onClick={() => onInsert(insertionAtEnd(steps))}>
              ＋ 添加一步
            </button>
          )}
        </main>

        <aside className={`qb-panel${panelOpen ? ' open' : ''}`}>
          <h2>
            QB
            <button className="btn ghost drawer-close" onClick={() => setPanelOpen(false)}>
              ✕
            </button>
          </h2>
          <div className="qb-feed">
            {detail.events.length === 0 ? (
              <p style={{ color: 'var(--text-faint)' }}>还没有事件。</p>
            ) : (
              detail.events
                .slice()
                .reverse()
                .map((e) => (
                  <div className={`qb-msg${e.kind === 'alert_raised' ? ' raised' : ''}`} key={e.id}>
                    {eventText(e, steps)}
                    {e.kind === 'alert_raised' && typeof e.payload.key === 'string' && !ended && (
                      <div>
                        <button
                          className="btn ghost"
                          title="30 分钟内这条不再推给发起人；到点还没解决会重新告诉他"
                          onClick={() => {
                            api
                              .snoozeAlert(task.id, String(e.payload.key))
                              .then(() => {
                                toast('好，30 分钟内这条不再推给发起人')
                                onChanged()
                              })
                              .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), { tone: 'error' }))
                          }}
                        >
                          我能搞定，先别提醒他
                        </button>
                      </div>
                    )}
                    <div className="when">{new Date(e.createdAt).toLocaleTimeString('zh-CN')}</div>
                  </div>
                ))
            )}
          </div>
        </aside>

        {blockedOpen && (
          <BlockedDialog
            teamEnabled={teamEnabled}
            onDone={(note) => {
              setBlockedOpen(false)
              if (note !== null) setStatus('blocked', note)
            }}
          />
        )}

        {situationOpen && (
          <SituationDialog
            onDone={(message) => {
              setSituationOpen(false)
              if (message !== null) {
                api.adapt(task.id, message).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
              }
            }}
          />
        )}

        {retroOpen && (
          <RetroDialog taskId={task.id} onDone={() => { setRetroOpen(false); onChanged() }} toast={toast} />
        )}

        {askOpen && (
          <AskDialog
            enabled={teamEnabled}
            initial={askText(
              task,
              current,
              current !== null ? (detail.evidence[current.id] ?? []) : [],
              current !== null ? detail.events : [],
            )}
            onDone={(body) => {
              setAskOpen(false)
              if (body === null) return
              api
                .askInitiator(task.id, { stepId: current?.id ?? null, body })
                .then((r) => {
                  if (r.sent) toast('已发给发起人，回答会出现在 QB 面板和这一步')
                  else {
                    void navigator.clipboard.writeText(body)
                    toast('还没配置团队服务：求助内容已复制，贴到 IM 里发（临时 · 复制到 IM）')
                  }
                })
                .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
            }}
          />
        )}

        {transcriptOpen && (
          <TranscriptDialog
            onDone={(text) => {
              setTranscriptOpen(false)
              if (text === null) return
              api
                .submitTranscript(task.id, text)
                .then((r) =>
                  toast(
                    r.matched > 0
                      ? `已把 ${r.matched} 段输出分回对应步骤${r.unmatched.length > 0 ? `，${r.unmatched.length} 条命令没对上步骤（runbook 之外的）` : ''}`
                      : '没认出任何对应步骤的命令',
                    r.unmatched.length > 0 ? { action: { label: '看看没对上的', run: () => toast(r.unmatched.join('\n')) } } : undefined,
                  ),
                )
                .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
            }}
          />
        )}
      </div>
    </div>
  )
}

/** 卡住了：一句原因（可选）。QB 带着它替执行者告诉发起人。 */
function BlockedDialog({ teamEnabled, onDone }: { teamEnabled: boolean; onDone: (note: string | null) => void }) {
  const [note, setNote] = useState('')
  const quick = ['在等权限/账号', '在等别人的回复', '环境坏了，自己修不了', '不知道下一步该怎么做']
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>卡住了</h3>
        <p className="dim">
          {teamEnabled ? 'QB 会马上替你告诉发起人（🔴），带上这句原因。' : '没配团队服务：会标记卡住，但发起人收不到。'}
          之后你一跑步骤或贴输出，就自动算"不卡了"。
        </p>
        <div className="chip-row">
          {quick.map((q) => (
            <button key={q} className="chip" onClick={() => setNote(q)}>
              {q}
            </button>
          ))}
        </div>
        <textarea autoFocus rows={2} placeholder="卡在哪了？（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button className="btn danger" onClick={() => onDone(note.trim())}>
            {teamEnabled ? '告诉发起人' : '标记卡住'}
          </button>
          <button className="btn ghost" onClick={() => onDone(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/** 任务列表里的一项：灵魂宝石 + 标题。 */
function TaskItem({ task, active, onOpen }: { task: Task; active: boolean; onOpen: () => void }) {
  return (
    <button className={`task-item${active ? ' active' : ''}${task.status === 'done' || task.status === 'abandoned' ? ' ended' : ''}`} onClick={onOpen}>
      <span className={`gem ${gemClass(task)}`}>{gem(task)}</span>
      <span className="title">{task.title}</span>
    </button>
  )
}

/** 已完成/放弃的任务折叠在列表底部（原先任务永远完成不了，列表只增不减）。 */
function FinishedTasks({ tasks, activeId, onOpen }: { tasks: Task[]; activeId: string | null; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="lesson-fold" style={{ margin: '8px 0 2px' }} onClick={() => setOpen((v) => !v)}>
        已结束 {tasks.length} 个 {open ? '▴' : '▸'}
      </button>
      {open && tasks.map((t) => <TaskItem key={t.id} task={t} active={t.id === activeId} onOpen={() => onOpen(t.id)} />)}
    </>
  )
}

/** 最近一次"卡住了"的原因（横幅显示）。 */
function blockedNote(events: Event[]): string {
  const last = [...events].reverse().find((e) => e.kind === 'task_blocked')
  const note = typeof last?.payload.note === 'string' ? last.payload.note : ''
  return note !== '' ? `卡住了：${note}` : '卡住了'
}

/** 问发起人：QB 代拟的正文（目标/命令/输出尾部/试过什么），可改可发。 */
function AskDialog({ enabled, initial, onDone }: { enabled: boolean; initial: string; onDone: (body: string | null) => void }) {
  const [text, setText] = useState(initial)
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{enabled ? '问发起人' : '问发起人（临时 · 复制到 IM）'}</h3>
        <p className="dim">QB 按上下文代拟了正文（报错尾部、已试过什么都在），改完再发。</p>
        <textarea
          autoFocus
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
        />
        <div className="row">
          <button className="btn primary" disabled={text.trim() === ''} onClick={() => onDone(text)}>
            {enabled ? '发给发起人' : '复制全文'}
          </button>
          <button className="btn ghost" onClick={() => onDone(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 情况变了 / 终端记录 ───────────────────────────────────────

const SITUATION_QUICK = ['被阻塞了', '环境跟预期不一样', '这步不需要了', '需要更多时间', '审批人不在']

/** 情况变了：快捷项 + 一句话 → 走同一套差异机制（方案 §3 模式 A）。 */
function SituationDialog({ onDone }: { onDone: (message: string | null) => void }) {
  const [text, setText] = useState('')
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>情况变了</h3>
        <div className="chip-row">
          {SITUATION_QUICK.map((q) => (
            <button key={q} className="chip" onClick={() => setText((t) => (t === '' ? q : `${t}；${q}`))}>
              {q}
            </button>
          ))}
        </div>
        <textarea
          autoFocus
          placeholder="这次和原计划有什么不同？（QB 会对照当前 runbook 出差异，逐项确认后应用）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <div className="row">
          <button className="btn primary" disabled={text.trim() === ''} onClick={() => onDone(text.trim())}>
            让 QB 出差异
          </button>
          <button className="btn ghost" onClick={() => onDone(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/** L0.5：贴一大段终端输出，按提示符切分、按命令分回各步。 */
function TranscriptDialog({ onDone }: { onDone: (text: string | null) => void }) {
  const [text, setText] = useState('')
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>贴一段终端记录</h3>
        <p className="dim">整段复制粘贴（带提示符）。QB 按提示符切成"命令 + 输出"，命令对得上步骤的自动归档成证据并判定预期。</p>
        <textarea
          autoFocus
          className="mono"
          placeholder={'[root@gpu-17 ~]# nvidia-smi\n…\n[root@gpu-17 ~]# vllm serve …\n…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
        />
        <div className="row">
          <button className="btn primary" disabled={text.trim() === ''} onClick={() => onDone(text)}>
            分回各步
          </button>
          <button className="btn ghost" onClick={() => onDone(null)}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/** 单元之间的插入条：悬停时出现"＋"。 */
/**
 * 复盘清单（捕获时机 7）：任务收尾时把沉淀候选列一遍——
 * 待确认的提议（失败后修好/情况变了/别人的底稿提议）+
 * 已回答但还没沉淀成坑的求助。逐条勾选，不想记的跳过。
 */
function RetroDialog({
  taskId,
  onDone,
  toast,
}: {
  taskId: string
  onDone: () => void
  toast: (text: string, opts?: Omit<Toast, 'id' | 'text'>) => void
}) {
  const [data, setData] = useState<{ offers: LessonOfferView[]; questions: Array<{ id: string; stepId: string | null; bodyMd: string; answerMd: string }> } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api.retro(taskId).then(setData).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
  }, [taskId, toast])

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
      setData(await api.retro(taskId))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const offerText = (o: LessonOfferView): string => {
    const at = o.stepTitle !== null ? `（${o.stepTitle}）` : ''
    switch (o.kind) {
      case 'fix':
        return `失败后改了命令才跑通${at}——记成坑`
      case 'question':
        return `发起人的回答${at}——沉淀成坑`
      case 'situation':
        return `情况变了：${String(o.payload.reason ?? '')}`
      case 'proposal':
        return `${String(o.payload.fromName ?? '')} 提议把「${String(o.payload.stepTitle ?? '')}」改回他那样`
      default:
        return `偏离底稿${at}——带回底稿`
    }
  }

  return (
    <div className="modal-backdrop" onClick={onDone}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>复盘 · 沉淀候选</h3>
        {data === null ? (
          <p className="dim">整理中……</p>
        ) : data.offers.length + data.questions.length === 0 ? (
          <p className="dim">没有待沉淀的候选。这次执行的过程已经都留在时间线里了。</p>
        ) : (
          <>
            {data.offers.map((o) => (
              <div key={o.id} className="retro-item">
                <span>{offerText(o)}</span>
                <span className="retro-actions">
                  {(o.kind === 'fix' || o.kind === 'question' || o.kind === 'situation') && (
                    <>
                      <button className="btn primary" disabled={busy === o.id} onClick={() => void act(o.id, () => api.acceptLessonOffer(o.id, { scope: 'team' }))}>
                        记成坑并共享
                      </button>
                      <button className="btn" disabled={busy === o.id} onClick={() => void act(o.id, () => api.acceptLessonOffer(o.id, { scope: 'personal' }))}>
                        只记给自己
                      </button>
                    </>
                  )}
                  {o.kind === 'deviation' && (
                    <button className="btn primary" disabled={busy === o.id} onClick={() => void act(o.id, () => api.acceptLessonOffer(o.id))}>
                      带回底稿
                    </button>
                  )}
                  {o.kind === 'proposal' && (
                    <button className="btn primary" disabled={busy === o.id} onClick={() => void act(o.id, () => api.acceptLessonOffer(o.id))}>
                      应用到我手里的底稿
                    </button>
                  )}
                  <button className="btn ghost" disabled={busy === o.id} onClick={() => void act(o.id, () => api.dismissLessonOffer(o.id))}>
                    跳过
                  </button>
                </span>
              </div>
            ))}
            {data.questions.map((q) => (
              <div key={q.id} className="retro-item">
                <span>
                  求助「{q.bodyMd.slice(0, 40)}{q.bodyMd.length > 40 ? '…' : ''}」已回答——沉淀成坑
                </span>
                <span className="retro-actions">
                  <button className="btn primary" disabled={busy === q.id} onClick={() => void act(q.id, () => api.questionLesson(q.id, { scope: 'team' }))}>
                    记成坑并共享
                  </button>
                  <button className="btn ghost" disabled={busy === q.id} onClick={() => void act(q.id, () => api.questionLesson(q.id, { scope: 'personal' }))}>
                    只记给自己
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onDone}>
            完成复盘
          </button>
        </div>
      </div>
    </div>
  )
}

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
 * 空 runbook 时的入口（方案 §3）：按优先级排四条路——
 * B 贴了素材 → 从素材整理；A 有底稿可推荐 → 以它为基础（复制 + 出差异）；
 * D 兜底 → 让 QB 起草；C 终端日志先落成素材再整理。
 */
function DraftPrompt({
  taskId,
  title,
  brief,
  job,
  partial,
  llmStatus,
  material,
  onOpenSettings,
  onChanged,
  toast,
}: {
  taskId: string
  title: string
  brief: string
  job: Job | undefined
  partial: PartialStep[]
  llmStatus: PurposeStatus | null
  material: { id: string; kind: string; filename: string | null } | null
  onOpenSettings: () => void
  onChanged: () => void
  toast: (text: string, opts?: { tone?: 'error' }) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [bases, setBases] = useState<BaseSuggestion[] | null>(null)
  const running = job?.status === 'running'
  const elapsed = useElapsed(running ? job!.startedAt : null)

  useEffect(() => {
    api
      .suggestBases(title)
      .then((list) => setBases(list.filter((b) => b.taskId !== taskId)))
      .catch(() => setBases([]))
  }, [title, taskId])

  const start = (): void => {
    setError(null)
    api.draft(taskId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const importFromMaterial = (): void => {
    if (material === null) return
    setError(null)
    api
      .importFromMaterial(taskId, material.id)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  /** 模式 A：复制底稿（血缘与参数跟着来），再拿这次的说明出差异。 */
  const startFromBase = (runbookId: string): void => {
    setError(null)
    api
      .basedOn(taskId, runbookId)
      .then(() => {
        onChanged()
        return api.adapt(taskId, brief.trim() !== '' ? brief.trim() : title)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  if (running) {
    return (
      <div>
        <p style={{ color: 'var(--text-dim)' }}>
          {job!.kind === 'import' ? 'QB 正在从素材整理' : 'QB 正在起草'}
          ……{job!.progress ?? ''} · 已等待 {elapsed} 秒
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
          {/* B：贴了素材——最高优先级，命令逐字来自原文 */}
          {material !== null && (
            <p>
              <button className="btn primary" onClick={importFromMaterial}>
                从素材整理
              </button>{' '}
              <span className="paste-hint">
                已有贴进来的{material.kind === 'terminal' ? '终端记录' : material.kind === 'script' ? '脚本' : '文档'}
                {material.filename !== null ? `（${material.filename}）` : ''}：QB 忠实整理，命令逐字保留、提取参数，标出改写与缺口。
              </span>
            </p>
          )}

          {/* A：底稿推荐 */}
          {bases !== null && bases.length > 0 && (
            <div className="base-suggestions">
              <p style={{ marginBottom: 4 }}>QB 找到了可以当底稿的：</p>
              {bases.map((b) => (
                <div key={b.taskId} className="base-row">
                  <span className="base-title">{b.title}</span>
                  <span className="dim">v{b.version} · {new Date(b.updatedAt).toLocaleDateString('zh-CN')}</span>
                  <button className="btn" onClick={() => startFromBase(b.runbookId)}>
                    以它为基础
                  </button>
                </div>
              ))}
              <p className="paste-hint">以它为基础 = 复制步骤和参数（血缘保留），再拿这次的说明出差异，逐项接受。</p>
            </div>
          )}

          {/* D：兜底 */}
          <p>
            <button className="btn" onClick={start}>
              让 QB 起草
            </button>{' '}
            <span className="paste-hint">没有素材也没有相似任务时才用：QB 起草的是猜测，每条命令都会标成"QB 写的"。</span>
          </p>

          {material === null && (
            <p className="paste-hint">
              更好的起点：把同事发的文档 / 脚本 / 聊天记录贴成素材（新任务页的"手头有什么"），QB 整理出来命令逐字可用。
            </p>
          )}
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
function RedraftButton({ taskId, job, asMenuItem = false }: { taskId: string; job: Job | undefined; asMenuItem?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const running = job?.status === 'running'
  const elapsed = useElapsed(running ? job!.startedAt : null)

  return (
    <>
      <button
        className={asMenuItem ? 'menu-item' : 'btn ghost'}
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

function NewTask({
  onCreated,
  teamUsers,
  teamEnabled,
  onOpenNav,
}: {
  onCreated: (t: Task) => void | Promise<void>
  teamUsers: TeamUser[]
  teamEnabled: boolean
  onOpenNav: () => void
}) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [material, setMaterial] = useState('')
  const [initiator, setInitiator] = useState('')
  const [busy, setBusy] = useState(false)
  // 发起人必须是团队里的名字：原先手打，打错了（或打成显示名）发起人永远看不到这个任务
  const matched = teamUsers.find((u) => u.name === initiator.trim() || u.displayName === initiator.trim())
  const unknownInitiator = teamEnabled && initiator.trim() !== '' && teamUsers.length > 0 && matched === undefined

  const submit = async (): Promise<void> => {
    if (title.trim() === '') return
    setBusy(true)
    try {
      const initiatorName = matched?.name ?? initiator.trim()
      const task = await api.createTask({
        title: title.trim(),
        briefMd: brief,
        ...(initiatorName !== '' ? { initiatorName } : {}),
      })
      if (material.trim() !== '') {
        await api.createMaterial(task.id, { kind: 'doc', text: material })
      }
      setTitle('')
      setBrief('')
      setMaterial('')
      setInitiator('')
      await onCreated(task)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="empty-state">
      <button className="btn ghost nav-toggle" style={{ position: 'absolute', top: 10, left: 10 }} onClick={onOpenNav}>
        ☰ 任务
      </button>
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
        <input
          placeholder={teamEnabled ? '发起人（谁派的活？从团队成员里选；留空 = 自己）' : '发起人（谁派的活？留空 = 自己。配好团队后他会实时看到进度与告警）'}
          value={initiator}
          list="qb-team-users"
          onChange={(e) => setInitiator(e.target.value)}
        />
        <datalist id="qb-team-users">
          {teamUsers.map((u) => (
            <option key={u.name} value={u.name}>
              {u.displayName}
            </option>
          ))}
        </datalist>
        {unknownInitiator && (
          <span className="verdict unclear" style={{ fontSize: 12.5 }}>
            团队里没有"{initiator.trim()}"——这样发起人看不到这个任务。从下拉里选一个人，或者让他先拿邀请链接注册。
          </span>
        )}
        {matched !== undefined && initiator.trim() !== matched.name && (
          <span className="dim">将记为 {matched.displayName}（{matched.name}）</span>
        )}
        <textarea
          className="mono"
          placeholder="手头有什么？贴同事发的文档 / 脚本 / 聊天记录 / 终端日志——QB 会忠实整理成 runbook，命令逐字保留"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
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
  return t.status === 'blocked' ? '○' : t.status === 'done' ? '✓' : t.status === 'abandoned' ? '✕' : '●'
}

function gemClass(t: Task): string {
  return t.status === 'blocked' ? 'stuck' : t.status === 'draft' ? 'wobble' : t.status === 'abandoned' ? 'faint' : 'ok'
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
    case 'task_created':
      return typeof payload.by === 'string' && payload.by !== '' && payload.remote === true ? `${payload.by} 派来了这个任务` : '创建了任务'
    case 'task_started':
      return '任务开始'
    case 'task_done':
      return '任务完成'
    case 'task_blocked':
      return `标记卡住了${typeof payload.note === 'string' && payload.note !== '' ? `：${payload.note}` : ''}`
    case 'task_resumed':
      return payload.auto === true ? '又开始动手了，不再算卡住' : '不卡了，继续'
    case 'task_abandoned':
      return `放弃了这个任务${typeof payload.note === 'string' && payload.note !== '' ? `：${payload.note}` : ''}`
    case 'task_reopened':
      return '重新打开了任务'
    case 'alert_raised': {
      const to = typeof payload.to === 'string' ? payload.to : '发起人'
      const msg = typeof payload.message === 'string' ? payload.message : ''
      return `QB 替你告诉了${to}：${msg}`
    }
    case 'alert_snoozed':
      return `你说能搞定：${typeof payload.minutes === 'number' ? payload.minutes : 30} 分钟内不再提醒发起人`
    case 'delegate_progress': {
      const who = typeof payload.assignee === 'string' ? payload.assignee : '对方'
      if (payload.note === '已委派') return `委派给了 ${who}`
      const progress = typeof payload.total === 'number' && payload.total > 0 ? ` ${String(payload.done)}/${payload.total}` : ''
      const st = payload.status === 'blocked' ? '卡住了' : payload.status === 'active' ? '在做' : String(payload.status ?? '')
      return `${who}${st}${progress}${payload.worstAlert === 'red' ? '（需要你看一眼）' : ''}`
    }
    case 'step_run':
      return payload.watch === 'only' ? `QB 开始盯着${which}` : payload.watch === 'run' ? `运行并盯着${which}` : `开始执行${which}`
    case 'step_ok':
      if (payload.source === 'delegate') return `${which}完成了（${typeof payload.by === 'string' ? payload.by : '对方'}做完了委派）`
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
    case 'comment': {
      const author = typeof payload.author === 'string' ? payload.author : '发起人'
      const body = typeof payload.body === 'string' ? payload.body : ''
      return `${author} 评论：${body}`
    }
    case 'question_asked':
      return '发出了求助（已通知发起人）'
    case 'question_answered': {
      const by = typeof payload.by === 'string' ? payload.by : '发起人'
      const answer = typeof payload.answer === 'string' ? payload.answer : ''
      return `${by} 回答了：${answer}`
    }
    case 'alert_acked':
      return '发起人知道了'
    case 'lesson_proposed':
      return payload.shared === true ? '记了个坑（已共享给团队）' : '记了个坑'
    case 'lesson_confirmed':
      return payload.status === 'confirmed'
        ? `${typeof payload.by === 'string' && payload.by !== '' ? payload.by : '发起人'} 确认了这个坑`
        : `这个坑被判定无效，降回只给自己`
    case 'lesson_shared': {
      const by = typeof payload.by === 'string' ? payload.by : '同事'
      const symptom = typeof payload.symptom === 'string' ? payload.symptom : ''
      return `${by} 在这一步记了个坑：${symptom}`
    }
    case 'base_proposal': {
      const from = typeof payload.from === 'string' && payload.from !== '' ? payload.from : null
      const title = typeof payload.stepTitle === 'string' ? payload.stepTitle : '某一步'
      if (payload.sent === true) return `把「${title}」的改动发给底稿负责人`
      if (payload.applied === 'accepted') return `底稿提议已应用：「${title}」`
      if (payload.applied === 'conflict') return `底稿提议冲突（自己的命令已改过）：「${title}」`
      if (payload.decided !== undefined) return `${typeof payload.by === 'string' && payload.by !== '' ? payload.by : '对方'}处理了你的底稿提议（${String(payload.decided)}）`
      return `${from !== null ? from : '同事'} 提议把「${title}」的命令改回底稿`
    }
    default:
      return e.kind
  }
}
