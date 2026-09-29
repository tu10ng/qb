import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Event, Param, Step, StepKind, Task } from '@qb/core'
import {
  adaptableSteps,
  depthOf,
  dropPosition,
  exportMarkdown,
  insertionAfter,
  insertionAtEnd,
  isContent,
  isDoable,
  isSection,
  machineName,
  machineParam,
  movedPosition,
  parseMachineLine,
  positionOf,
  type MoveDirection,
  type Position,
} from '@qb/core'
import {
  ApiError,
  api,
  connectEvents,
  type AdaptProposal,
  type Job,
  type LessonOfferView,
  type NewStepInput,
  type PartialStep,
  type PurposeStatus,
  type QaItem,
  type ServerEvent,
  type StepPatchInput,
  type SyncStatus,
  type TaskDetail,
  type TeamUser,
} from './api.ts'
import { StepCell, formatMs, readAsDataUrl, type StepActions, type StepRunState } from './StepCell.tsx'
import { Settings } from './Settings.tsx'
import { ParamsPanel } from './ParamsPanel.tsx'
import { AdaptCard } from './AdaptCard.tsx'
import { SidePanel } from './SidePanel.tsx'
import { DocImportCard, GraftDialog, StartPanel, kindMark, useElapsed } from './StartPanel.tsx'
import { renderMarkdown } from './highlight.ts'
import { useHistory } from './history.ts'

/** 大纲里拖拽步骤时 dataTransfer 用的类型。 */
const DRAG_TYPE = 'application/x-qb-step'

interface Toast {
  id: number
  text: string
  tone?: 'error'
  action?: { label: string; run: () => void }
}

/** 新块的默认内容：命令和文字都不用先起标题（按内容自动取）。 */
function newBlock(kind: StepKind): NewStepInput {
  switch (kind) {
    case 'section':
      return { kind, title: '新章节' }
    case 'note':
      return { kind, title: '文字', titleAuto: true }
    case 'code':
      return { kind, title: '代码', titleAuto: true, lang: 'bash' }
    case 'output':
      return { kind, title: '回显', titleAuto: true }
    case 'manual':
      return { kind, title: '新的一步' }
    default:
      return { kind: 'command', title: '命令', titleAuto: true, lang: 'bash' }
  }
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
  // 刚插入的块：直接进入编辑
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [llmStatus, setLlmStatus] = useState<PurposeStatus | null>(null)
  const [teamEnabled, setTeamEnabled] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  // 问答（原"坑"）与待确认的捕获提议
  const [qa, setQa] = useState<QaItem[]>([])
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
    // 问答与捕获提议跟 detail 一起刷；失败不影响主界面
    void api
      .qa(taskId)
      .then((items) => {
        if (activeRef.current === taskId) setQa(items)
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
    setQa([])
    setLessonOffers([])
    if (activeId === null) return
    void refreshDetail(activeId)
  }, [activeId, refreshDetail])

  // 事件流：步骤输出、完成、编辑、重规划、后台任务
  useEffect(() => {
    const refreshIfActive = (taskId: string): void => {
      if (activeRef.current === taskId) void refreshDetail(taskId)
    }
    return connectEvents(
      (e: ServerEvent) => {
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
                partial: e.partial === true,
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
      },
    )
  }, [refreshDetail, refreshTasks])

  const steps = detail?.steps ?? []
  const runbook = detail?.runbook ?? null

  // 当前步：优先第一个在跑的、再是第一个没做的（文档内容不算），用户点击可覆盖。
  // QB 在盯着的 wait 步骤、交给别人的委派步骤不占"当前"——"我盯着，你先看下一步"
  const autoCurrent = useMemo(
    () =>
      steps.find((s) => s.status === 'running' && s.kind !== 'wait' && s.kind !== 'delegate') ??
      steps.find((s) => s.status === 'pending' && isDoable(s)) ??
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

  /** 确保有 runbook（自己写的第一块、挑步骤进来之前）。 */
  const ensureRunbook = useCallback(async (): Promise<string | null> => {
    const d = detailRef.current
    if (d === null) return null
    if (d.runbook !== null) return d.runbook.id
    const r = await api.blankRunbook(d.task.id)
    await reload()
    return r.runbook.id
  }, [reload])

  const insertAt = useCallback(
    async (pos: Position, input: NewStepInput = newBlock('command')): Promise<Step | null> => {
      try {
        const runbookId = await ensureRunbook()
        if (runbookId === null) return null
        const step = await api.insertStep(runbookId, { ...pos, step: input })
        history.push({
          label: '插入一块',
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
    [ensureRunbook, history, reload, toast],
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

  /**
   * 拆开：第一段留在原块（原块是命令就换成第一条命令；第一段是说明时，原块
   * 变成那段说明），其余依次插在后面。整体一次撤销。
   */
  const splitStep = useCallback(
    async (step: Step, parts: NewStepInput[]): Promise<void> => {
      if (runbook === null || parts.length < 2) return
      const before: StepPatchInput = { kind: step.kind, title: step.title, titleAuto: step.titleAuto, command: step.command, bodyMd: step.bodyMd, lang: step.lang }
      const [first, ...rest] = parts
      const firstPatch: StepPatchInput =
        first!.kind === 'note'
          ? { kind: 'note', bodyMd: first!.bodyMd ?? null, command: null, titleAuto: true }
          : { kind: step.kind === 'note' ? 'command' : step.kind, command: first!.command ?? null, lang: first!.lang ?? step.lang, ...(first!.titleAuto === false ? { title: first!.title } : { titleAuto: true }) }
      try {
        await editStep(step, firstPatch, false)
        const inserted = await api.insertSteps(runbook.id, {
          parentId: step.parentId,
          afterId: step.id,
          steps: rest.map((p) => (p.kind === 'command' && step.kind !== 'note' && step.kind !== 'command' ? { ...p, kind: step.kind } : p)),
        })
        history.push({
          label: `拆成 ${parts.length} 块`,
          undo: async () => {
            for (const s of [...inserted].reverse()) await api.deleteStep(s.id)
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, before))
            await reload()
          },
          redo: async () => {
            for (const s of inserted) await api.restoreStep(s.id)
            await withFreshRev(step.id, (rev) => api.updateStep(step.id, rev, firstPatch))
            await reload()
          },
        })
        toast(`已拆成 ${parts.length} 块`)
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
      const next: Param[] = [...d.runbook.params, ...names.filter((n) => !have.has(n)).map((name) => ({ name, value: '', source: 'mine' as const, secret: false }))]
      try {
        await api.updateParams(d.task.id, next)
        toast(`已声明 ${names.join('、')}，在参数面板里填上值就能运行`)
        setFocusParam(names[0] ?? null)
        await reload()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      }
    },
    [reload, toast],
  )

  /** 贴进来一行 "IP 用户 密码"：存成机器参数（密码是 secret，只存本机）。 */
  const addMachine = useCallback(
    async (step: Step, text: string): Promise<string | null> => {
      const d = detailRef.current
      if (d === null || d.runbook === null) return null
      const m = parseMachineLine(text)
      if (m === null) {
        toast('没认出这台机器的 IP 或主机名', { tone: 'error' })
        return null
      }
      const existing = d.runbook.params.find((p) => p.value === m.host && p.fields !== undefined)
      const p = existing ?? machineParam(m, machineName(m.host, new Set(d.runbook.params.map((x) => x.name))))
      try {
        if (existing === undefined) await api.updateParams(d.task.id, [...d.runbook.params, p])
        const hint = `ssh ${m.user !== null ? `{{${p.name}.用户}}@` : ''}{{${p.name}}}${m.port !== null ? ` -p {{${p.name}.端口}}` : ''}`
        // 这一步本来是空的：直接写上登录命令（密码不进命令，用 {{名字.密码}} 引用）
        if (step.command === null || step.command.trim() === '') await editStep(step, { command: hint }, false)
        toast(existing !== undefined ? `这台机器已经是参数 ${p.name} 了` : `已存成参数 ${p.name}（密码打码、只存本机）。命令里写 {{${p.name}}}、{{${p.name}.用户}}、{{${p.name}.密码}}`)
        setFocusParam(p.name)
        await reload()
        return p.name
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
        return null
      }
    },
    [editStep, reload, toast],
  )

  const [focusParam, setFocusParam] = useState<string | null>(null)
  const [qaFor, setQaFor] = useState<string | null>(null)
  const [askFor, setAskFor] = useState<{ stepId: string | null; lessonId?: string; question?: string } | null>(null)

  const actionsFor = useCallback(
    (step: Step): StepActions => ({
      edit: (patch) => editStep(step, patch),
      insertAfter: (kind = 'command') => void insertAt(insertionAfter(step, detailRef.current?.steps ?? []), newBlock(kind)),
      remove: () => void removeStep(step),
      move: (dir) => moveStep(step, dir),
      setStatus: (status, note) => void setStatus(step, status, note),
      split: (parts) => void splitStep(step, parts),
      uploadImage: (file) => void uploadImage(step, file),
      delegate: (input) => delegateStep(step, input),
      declareParams: (names) => void declareParams(names),
      addMachine: (text) => addMachine(step, text),
      focusParam: (name) => setFocusParam(name),
      addQa: () => setQaFor(step.id),
      ask: () => setAskFor({ stepId: step.id }),
    }),
    [editStep, insertAt, removeStep, moveStep, setStatus, splitStep, uploadImage, delegateStep, declareParams, addMachine],
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
      if (e.key === '/') {
        e.preventDefault()
        void insertAt(current !== null ? insertionAfter(current, steps) : insertionAtEnd(steps))
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
  }, [view, detail, steps, current, currentId, undo, redo, insertAt, moveStep, removeStep])

  // 截图直接 Ctrl+V：贴到当前步（要做的步骤）。不需要先找输入框。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (view !== 'task' || current === null || isContent(current)) return
      if (isTyping(e.target)) return
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
          {ongoing.length === 0 && (
            <p className="dim" style={{ padding: '6px 9px' }}>
              没有进行中的任务。
            </p>
          )}
          {finished.length > 0 && <FinishedTasks tasks={finished} activeId={view === 'task' ? activeId : null} onOpen={openTask} />}
        </div>
        <div className="sidebar-foot">
          <button
            className={`btn ghost${view === 'settings' ? ' on' : ''}`}
            onClick={() => {
              setView('settings')
              setSidebarOpen(false)
            }}
          >
            ⚙ 设置
          </button>
          {llmStatus !== null && !llmStatus.ok && (
            <span className="dim" style={{ fontSize: 12 }} title="不配模型也能用：自己写、导入 md/org、从别的任务挑。起草、整理素材、诊断要模型">
              没配模型（自己写、导入都能用）
            </span>
          )}
          {teamEnabled && syncStatus !== null && (
            <span className={`verdict ${syncStatus.ok === false ? 'fail' : 'pass'}`} style={{ fontSize: 12 }} title={syncStatus.detail}>
              {syncStatus.ok === false ? `团队同步失败：${syncStatus.detail}` : syncStatus.ok === true ? '团队：已同步' : '团队：连接中…'}
            </span>
          )}
        </div>
      </aside>

      {view === 'settings' ? (
        <Settings jobs={jobs} />
      ) : activeId === null ? (
        <NewTask
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
          onInsert={(pos, kind) => void insertAt(pos, newBlock(kind ?? 'command'))}
          onDrop={(dragged, target) => {
            const to = dropPosition(steps, target, dragged)
            if (to !== null) void moveTo(dragged, to)
          }}
          onChanged={() => {
            void reload()
            void refreshTasks()
          }}
          onOpenSettings={() => setView('settings')}
          onOpenNav={() => setSidebarOpen(true)}
          teamEnabled={teamEnabled}
          teamUsers={teamUsers}
          toast={toast}
          qa={qa}
          offers={lessonOffers}
          focusParam={focusParam}
          onFocusParam={setFocusParam}
          qaFor={qaFor}
          onQaFor={setQaFor}
          askFor={askFor}
          onAskFor={setAskFor}
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
  onInsert: (pos: Position, kind?: StepKind) => void
  onDrop: (dragged: Step, target: Step) => void
  onChanged: () => void
  onOpenSettings: () => void
  /** 窄屏：打开任务列表抽屉。 */
  onOpenNav: () => void
  /** 配好团队服务时"问发起人"走真实发送。 */
  teamEnabled: boolean
  teamUsers: TeamUser[]
  toast: (text: string, opts?: Omit<Toast, 'id' | 'text'>) => void
  qa: QaItem[]
  offers: LessonOfferView[]
  focusParam: string | null
  onFocusParam: (name: string | null) => void
  /** 在哪一步上记问答（弹出表单）。 */
  qaFor: string | null
  onQaFor: (stepId: string | null) => void
  /** 问发起人（带上某一步 / 某条问答）。 */
  askFor: { stepId: string | null; lessonId?: string; question?: string } | null
  onAskFor: (v: { stepId: string | null; lessonId?: string; question?: string } | null) => void
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
  qa,
  offers,
  focusParam,
  onFocusParam,
  qaFor,
  onQaFor,
  askFor,
  onAskFor,
}: TaskPageProps) {
  const { task, runbook, steps } = detail
  const currentRef = useRef<HTMLDivElement>(null)
  const paramsRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // 差异卡片：job 一次一换 id，按 id 记住"先不用"
  const [adaptDismissedJob, setAdaptDismissedJob] = useState<string | null>(null)
  const [situationOpen, setSituationOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [retroOpen, setRetroOpen] = useState(false)
  const [blockedOpen, setBlockedOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [graftAt, setGraftAt] = useState<Position | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // 窄屏（和 SecureCRT 并排）时大纲与侧栏收成抽屉
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  // 折叠的章节（本机记住，按任务）
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(task.id))
  useEffect(() => setCollapsed(loadCollapsed(task.id)), [task.id])
  const toggleCollapse = (id: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveCollapsed(task.id, next)
      return next
    })

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentId])
  useEffect(() => {
    if (focusParam !== null) paramsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusParam])

  const real = steps.filter(isDoable)
  const done = real.filter((s) => s.status === 'ok' || s.status === 'skipped').length
  const ended = task.status === 'done' || task.status === 'abandoned'
  // 每一步都做完了（或跳过），任务却还没完成：提示一句，完成即复盘
  const allDone = real.length > 0 && done === real.length && !ended
  const startJob = jobs[task.id]
  const draftJob = startJob?.kind === 'draft' ? startJob : undefined
  const importJob = startJob?.kind === 'import' ? startJob : undefined
  const adaptJob = startJob?.kind === 'adapt' ? startJob : undefined
  const adaptProposal = adaptJob?.status === 'done' ? (adaptJob.result as AdaptProposal | null) : null
  const showAdapt = adaptProposal !== null && adaptDismissedJob !== adaptJob!.id
  const params = runbook?.params ?? []
  const fidelityByStep = new Map((detail.fidelity?.items ?? []).map((i) => [i.stepId, i]))
  const sections = steps.filter(isSection)

  // 被折叠的章节里的块不显示（大纲和正文都是）
  const hidden = useMemo(() => {
    const out = new Set<string>()
    for (const s of steps) if (s.parentId !== null && (collapsed.has(s.parentId) || out.has(s.parentId))) out.add(s.id)
    return out
  }, [steps, collapsed])
  const depths = useMemo(() => new Map(steps.map((s) => [s.id, depthOf(steps, s)])), [steps])
  const qaByStep = useMemo(() => {
    const m: Record<string, QaItem[]> = {}
    for (const q of qa) if (q.stepId !== null) (m[q.stepId] ??= []).push(q)
    return m
  }, [qa])

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

  const exportMd = (): void => {
    const md = exportMarkdown(task.title, steps, params)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${task.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const initiatorName = detail.initiator?.displayName ?? null
  const noRunbook = runbook === null || steps.length === 0

  return (
    <div className="task-page">
      <header className="task-header">
        <button className="btn ghost nav-toggle" title="任务列表" onClick={onOpenNav}>
          ☰
        </button>
        <h1>
          <TitleEdit task={task} onChanged={onChanged} toast={toast} />
        </h1>
        <span className="task-meta">
          <span className={`gem ${gemClass(task)}`}>{gem(task)}</span> {statusLabel(task)}
          {real.length > 0 && ` · ${done}/${real.length}`}
          {task.expectedMinutes !== null && ` · 预计 ${task.expectedMinutes} 分钟`}
        </span>
        <span className="spacer" />
        <span className="task-meta keys" title="快捷键">
          / 插入 · Alt+↑↓ 移动 · Tab 缩进 · Delete 删除 · Ctrl+Z 撤销
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
                onClick={() => onAskFor({ stepId: current?.id ?? null })}
              >
                问发起人{teamEnabled ? '' : '（复制到 IM）'}
              </button>
              {steps.length > 0 && (
                <>
                  <button className="btn" onClick={() => setSituationOpen(true)} disabled={llmStatus !== null && !llmStatus.ok} title={llmStatus !== null && !llmStatus.ok ? '要先配模型' : undefined}>
                    情况变了…
                  </button>
                  <button className="btn" onClick={() => setTranscriptOpen(true)} title="自己在外部终端里跑了几步？把整段回显贴进来，QB 按命令分回各步">
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
                {!noRunbook && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMoreOpen(false)
                      setGraftAt(insertionAtEnd(steps))
                    }}
                  >
                    从别的任务挑章节/步骤…
                  </button>
                )}
                {!noRunbook && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMoreOpen(false)
                      setImportOpen(true)
                    }}
                  >
                    导入 md / org（替换或接在后面）…
                  </button>
                )}
                {!noRunbook && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMoreOpen(false)
                      exportMd()
                    }}
                  >
                    导出 markdown
                  </button>
                )}
                {steps.length > 0 && !ended && (llmStatus === null || llmStatus.ok) && <RedraftButton taskId={task.id} job={draftJob} asMenuItem />}
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
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMoreOpen(false)
                      setStatus('active')
                    }}
                  >
                    重新打开
                  </button>
                )}
                <button
                  className="menu-item panel-toggle"
                  onClick={() => {
                    setMoreOpen(false)
                    setPanelOpen(true)
                  }}
                >
                  看这一步 / 问答 / 记录
                </button>
              </div>
            )}
          </span>
        </div>
      </header>

      <div className="task-body">
        <nav className={`outline${outlineOpen ? ' open' : ''}`} onClick={() => setOutlineOpen(false)}>
          {steps
            .filter((s) => !hidden.has(s.id))
            .map((s) => (
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
                className={`outline-item kind-${s.kind}${s.id === currentId ? ' current' : ''}${isSection(s) ? ' section' : ''}${dragId === s.id ? ' dragging' : ''}`}
                style={{ paddingLeft: 8 + (depths.get(s.id) ?? 0) * 14 }}
                onClick={() => onSelectStep(s.id)}
                onDoubleClick={() => isSection(s) && toggleCollapse(s.id)}
              >
                <span title={qaByStep[s.id] !== undefined ? '这一步有问答' : undefined}>
                  {isSection(s) ? (collapsed.has(s.id) ? '▸' : '▾') : isContent(s) ? kindMark(s.kind) : outlineMark(s)}
                  {qaByStep[s.id] !== undefined && <span className="lesson-dot">？</span>}
                </span>
                <span className="t">{s.title}</span>
              </button>
            ))}
        </nav>

        <main className="runbook">
          <TaskInfo task={task} initiatorName={initiatorName} teamUsers={teamUsers} teamEnabled={teamEnabled} onChanged={onChanged} toast={toast} />

          {/* 重新起草 / 导入也流式显示：不用等整份写完才知道 QB 在写什么 */}
          {(draftJob?.status === 'running' || importJob?.status === 'running') && steps.length > 0 && (
            <div className="redrafting">
              <p style={{ color: 'var(--text-dim)', margin: '0 0 6px' }}>
                {importJob !== undefined ? 'QB 正在从素材整理' : 'QB 正在重新起草'}
                ……{(importJob ?? draftJob)!.progress ?? ''}（现在的 runbook 仍在，替换前会留快照）
              </p>
              {partial.map((s, i) => (
                <div className="ghost-step" key={i}>
                  {(i === 0 || partial[i - 1]!.section !== s.section) && s.section !== '' && <div className="ghost-section">{s.section}</div>}
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
              steps={adaptableSteps(steps)}
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

          {runbook !== null && (
            <div ref={paramsRef}>
              <ParamsPanel taskId={task.id} params={params} sections={sections} steps={steps} focus={focusParam} onChanged={onChanged} toast={toast} />
            </div>
          )}

          {/* 导入来的 runbook：保真概况一行（参数一改会跟着变） */}
          {detail.fidelity !== null && (
            <div className="fidelity-strip">
              来自素材：{detail.fidelity.items.filter((i) => i.verbatim).length}/{detail.fidelity.items.length} 条命令逐字 · {detail.fidelity.items.filter((i) => !i.verbatim && !i.unverified).length} 条 QB 改写过 · 素材里 {detail.fidelity.uncoveredCount} 行命令没用上
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

          {noRunbook && (
            <StartPanel
              taskId={task.id}
              title={task.title}
              brief={task.briefMd}
              job={importJob ?? draftJob}
              partial={partial}
              llmStatus={llmStatus}
              material={detail.material}
              onOpenSettings={onOpenSettings}
              onChanged={onChanged}
              onStartBlank={(kind) => onInsert({ parentId: null, afterId: null }, kind)}
              toast={toast}
            />
          )}

          {steps
            .filter((s) => !hidden.has(s.id))
            .map((s) => (
              <div key={s.id} ref={s.id === currentId ? currentRef : undefined}>
                <StepCell
                  step={s}
                  steps={steps}
                  depth={depths.get(s.id) ?? 0}
                  current={s.id === currentId}
                  collapsed={collapsed.has(s.id)}
                  onToggleCollapse={() => toggleCollapse(s.id)}
                  runState={runStates[s.id]}
                  evidence={detail.evidence[s.id] ?? []}
                  params={params}
                  fidelity={fidelityByStep.get(s.id)}
                  job={jobs[s.id]}
                  lastEdit={lastEdits[s.id]}
                  autoEdit={s.id === editTarget}
                  canMove={canMoveOf(s)}
                  qa={qaByStep[s.id] ?? []}
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
                {qaFor === s.id && <QaFormFor taskId={task.id} step={s} onDone={() => { onQaFor(null); onChanged() }} />}
                <InsertBar
                  onInsert={(kind) => onInsert(insertionAfter(s, steps, collapsed.has(s.id)), kind)}
                  onGraft={() => setGraftAt(insertionAfter(s, steps, collapsed.has(s.id)))}
                />
              </div>
            ))}

          {runbook !== null && steps.length > 0 && (
            <div className="add-row">
              {(['command', 'note', 'section', 'code', 'output'] as const).map((k) => (
                <button key={k} className="btn ghost" onClick={() => onInsert(insertionAtEnd(steps), k)}>
                  ＋ {KIND_NAME[k]}
                </button>
              ))}
              <button className="btn ghost" onClick={() => setGraftAt(insertionAtEnd(steps))}>
                ＋ 从别的任务挑…
              </button>
            </div>
          )}
        </main>

        <aside className={`qb-panel${panelOpen ? ' open' : ''}`}>
          <SidePanel
            steps={steps}
            params={params}
            events={detail.events}
            qa={qa}
            current={current}
            taskId={task.id}
            ended={ended}
            onClose={() => setPanelOpen(false)}
            onChanged={onChanged}
            onAsk={(opts) => onAskFor(opts)}
            onFocusParam={(n) => onFocusParam(n)}
            eventText={(e) => eventText(e, steps)}
            renderAlertAction={(e) =>
              e.kind === 'alert_raised' && typeof e.payload.key === 'string' ? (
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
              ) : null
            }
          />
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
          <RetroDialog
            taskId={task.id}
            onDone={() => {
              setRetroOpen(false)
              onChanged()
            }}
            toast={toast}
          />
        )}

        {askFor !== null && (
          <AskDialog
            enabled={teamEnabled}
            initial={askText(task, askFor.stepId !== null ? (steps.find((s) => s.id === askFor.stepId) ?? null) : current, askFor.stepId !== null ? (detail.evidence[askFor.stepId] ?? []) : current !== null ? (detail.evidence[current.id] ?? []) : [], detail.events, params, askFor.question)}
            onDone={(body) => {
              const target = askFor
              onAskFor(null)
              if (body === null) return
              api
                .askInitiator(task.id, { stepId: target.stepId ?? current?.id ?? null, body, ...(target.lessonId !== undefined ? { lessonId: target.lessonId } : {}) })
                .then((r) => {
                  if (r.sent) toast(target.lessonId !== undefined ? '已发给发起人，回答回来会自动填进这条问答' : '已发给发起人，回答会出现在这一步')
                  else {
                    void navigator.clipboard.writeText(body)
                    toast('还没配置团队服务：求助内容已复制，贴到 IM 里发（临时 · 复制到 IM）')
                  }
                  onChanged()
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
                    r.matched > 0 ? `已把 ${r.matched} 段回显分回对应步骤${r.unmatched.length > 0 ? `，${r.unmatched.length} 条命令没对上步骤（runbook 之外的）` : ''}` : '没认出任何对应步骤的命令',
                    r.unmatched.length > 0 ? { action: { label: '看看没对上的', run: () => toast(r.unmatched.join('\n')) } } : undefined,
                  ),
                )
                .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
            }}
          />
        )}

        {graftAt !== null && <GraftDialog taskId={task.id} target={graftAt} onClose={() => setGraftAt(null)} onDone={onChanged} toast={toast} />}

        {importOpen && (
          <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
            <div className="modal wide" onClick={(e) => e.stopPropagation()}>
              <h3>导入 md / org</h3>
              <p className="dim">导入会整份替换现在的内容（先留快照，可以在 ⋯ 里找回）。要接在后面，用"从别的任务挑"或先导进一个新任务。</p>
              <DocImportCard
                taskId={task.id}
                compact
                onDone={() => {
                  setImportOpen(false)
                  onChanged()
                }}
                toast={toast}
              />
              <div className="row">
                <button className="btn ghost" onClick={() => setImportOpen(false)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const KIND_NAME: Record<'command' | 'note' | 'section' | 'code' | 'output', string> = {
  command: '命令',
  note: '文字',
  section: '章节',
  code: '代码',
  output: '回显',
}

/** 在某一步上记一条问答（从 ⋯ 或"＋ 问答"打开）。 */
function QaFormFor({ taskId, step, onDone }: { taskId: string; step: Step; onDone: () => void }) {
  const [QaForm, setQaForm] = useState<typeof import('./StepCell.tsx').QaForm | null>(null)
  useEffect(() => {
    void import('./StepCell.tsx').then((m) => setQaForm(() => m.QaForm))
  }, [])
  if (QaForm === null) return null
  return (
    <div className="qa-inline-form">
      <div className="dim">在「{step.title}」上记一条问答</div>
      <QaForm
        withScope
        onCancel={onDone}
        onSubmit={async (v) => {
          await api.addQa(taskId, { question: v.question, answer: v.answer, stepId: step.id, condition: v.condition === '' ? null : v.condition, scope: v.scope })
          onDone()
        }}
      />
    </div>
  )
}

/** 标题：点一下就改。 */
function TitleEdit({ task, onChanged, toast }: { task: Task; onChanged: () => void; toast: (text: string, opts?: { tone?: 'error' }) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  useEffect(() => setDraft(task.title), [task.title])
  if (!editing)
    return (
      <span className="editable" title="点击改标题" onClick={() => setEditing(true)}>
        {task.title}
      </span>
    )
  const save = (): void => {
    setEditing(false)
    const t = draft.trim()
    if (t === '' || t === task.title) return
    api
      .updateTask(task.id, { title: t })
      .then(onChanged)
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
  }
  return (
    <input
      className="inline-edit editing title-edit"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') {
          setDraft(task.title)
          setEditing(false)
        }
      }}
    />
  )
}

/**
 * 任务信息：说明、发起人、预期都是建完再补的（建任务只要一句"要做什么"）。
 * 空着的就折成一行"＋ 补充说明 · ＋ 谁派的活"，不占地方。
 */
function TaskInfo({
  task,
  initiatorName,
  teamUsers,
  teamEnabled,
  onChanged,
  toast,
}: {
  task: Task
  initiatorName: string | null
  teamUsers: TeamUser[]
  teamEnabled: boolean
  onChanged: () => void
  toast: (text: string, opts?: { tone?: 'error' }) => void
}) {
  const [editing, setEditing] = useState<'brief' | 'initiator' | 'minutes' | null>(null)
  const [brief, setBrief] = useState(task.briefMd)
  const [who, setWho] = useState('')
  const [minutes, setMinutes] = useState(task.expectedMinutes === null ? '' : String(task.expectedMinutes))
  useEffect(() => setBrief(task.briefMd), [task.briefMd])
  useEffect(() => setMinutes(task.expectedMinutes === null ? '' : String(task.expectedMinutes)), [task.expectedMinutes])
  const selfTask = task.initiatorId === task.assigneeId
  const briefHtml = useMemo(() => (task.briefMd.trim() === '' ? '' : markdownOf(task.briefMd)), [task.briefMd])

  const save = (patch: Parameters<typeof api.updateTask>[1]): void => {
    setEditing(null)
    api
      .updateTask(task.id, patch)
      .then(onChanged)
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
  }
  const matched = teamUsers.find((u) => u.name === who.trim() || u.displayName === who.trim())
  const unknown = teamEnabled && who.trim() !== '' && teamUsers.length > 0 && matched === undefined

  return (
    <div className="task-info" onKeyDown={(e) => e.stopPropagation()}>
      {editing === 'brief' ? (
        <div>
          <textarea
            className="inline-edit editing brief-edit"
            autoFocus
            rows={4}
            value={brief}
            placeholder="目标、约束、完成标准、已知的坑（markdown）"
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setBrief(task.briefMd)
                setEditing(null)
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save({ briefMd: brief })
            }}
          />
          <div className="cap-actions">
            <button className="btn primary" onClick={() => save({ briefMd: brief })}>
              保存
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setBrief(task.briefMd)
                setEditing(null)
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : task.briefMd.trim() !== '' ? (
        <div className="brief md" title="点击编辑" onClick={(e) => (e.target as HTMLElement).closest('a') === null && setEditing('brief')} dangerouslySetInnerHTML={{ __html: briefHtml }} />
      ) : null}

      <div className="info-row">
        {task.briefMd.trim() === '' && editing !== 'brief' && (
          <button className="lesson-fold" onClick={() => setEditing('brief')}>
            ＋ 补充说明
          </button>
        )}
        {editing === 'initiator' ? (
          <span className="info-edit">
            <input
              className="inline-edit editing"
              autoFocus
              list="qb-team-users"
              placeholder={teamEnabled ? '谁派的活？从团队成员里选；空着 = 自己' : '谁派的活？空着 = 自己'}
              value={who}
              onChange={(e) => setWho(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !unknown) save({ initiatorName: matched?.name ?? who.trim() })
                if (e.key === 'Escape') setEditing(null)
              }}
            />
            <datalist id="qb-team-users">
              {teamUsers.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.displayName}
                </option>
              ))}
            </datalist>
            <button className="btn primary" disabled={unknown} onClick={() => save({ initiatorName: matched?.name ?? who.trim() })}>
              好
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              取消
            </button>
            {unknown && <span className="verdict unclear">团队里没有"{who.trim()}"——从下拉里选，或者让他先拿邀请链接注册</span>}
          </span>
        ) : (
          <button
            className="lesson-fold"
            onClick={() => {
              setWho(selfTask ? '' : (initiatorName ?? ''))
              setEditing('initiator')
            }}
            title={teamEnabled ? '发起人会实时看到进度、收到告警和求助' : '配好团队服务后，发起人会实时看到进度与告警'}
          >
            {selfTask ? '＋ 谁派的活' : `发起人：${initiatorName ?? '（未知）'}`}
          </button>
        )}
        {editing === 'minutes' ? (
          <span className="info-edit">
            <input
              className="inline-edit editing"
              autoFocus
              style={{ width: 80 }}
              placeholder="分钟"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = Number(minutes)
                  save({ expectedMinutes: minutes.trim() === '' ? null : Number.isInteger(n) && n > 0 ? n : task.expectedMinutes })
                }
                if (e.key === 'Escape') setEditing(null)
              }}
              onBlur={() => setEditing(null)}
            />
          </span>
        ) : (
          <button className="lesson-fold" onClick={() => setEditing('minutes')}>
            {task.expectedMinutes === null ? '＋ 预计多久' : `预计 ${task.expectedMinutes} 分钟`}
          </button>
        )}
        {task.briefMd.trim() !== '' && editing !== 'brief' && (
          <button className="lesson-fold" onClick={() => setEditing('brief')}>
            改说明
          </button>
        )}
      </div>
    </div>
  )
}

function markdownOf(md: string): string {
  return renderMarkdown(md)
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
          之后你一跑步骤或贴回显，就自动算"不卡了"。
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

/** 问发起人：QB 代拟的正文（目标/命令/回显尾部/试过什么），可改可发。 */
function AskDialog({ enabled, initial, onDone }: { enabled: boolean; initial: string; onDone: (body: string | null) => void }) {
  const [text, setText] = useState(initial)
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h3>{enabled ? '问发起人' : '问发起人（临时 · 复制到 IM）'}</h3>
        <p className="dim">QB 按上下文代拟了正文（回显尾部、已试过什么都在，secret 已打码），改完再发。</p>
        <textarea autoFocus className="mono" value={text} onChange={(e) => setText(e.target.value)} rows={12} />
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
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h3>情况变了</h3>
        <div className="chip-row">
          {SITUATION_QUICK.map((q) => (
            <button key={q} className="chip" onClick={() => setText((t) => (t === '' ? q : `${t}；${q}`))}>
              {q}
            </button>
          ))}
        </div>
        <textarea autoFocus placeholder="这次和原计划有什么不同？（QB 会对照当前 runbook 出差异，逐项确认后应用）" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
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
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h3>贴一段终端记录</h3>
        <p className="dim">整段复制粘贴（带提示符）。QB 按提示符切成"命令 + 回显"，命令对得上步骤的自动归档成证据并判定预期。</p>
        <textarea autoFocus className="mono" placeholder={'[root@gpu-17 ~]# nvidia-smi\n…\n[root@gpu-17 ~]# vllm serve …\n…'} value={text} onChange={(e) => setText(e.target.value)} rows={10} />
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

/**
 * 复盘清单（捕获时机 7）：任务收尾时把沉淀候选列一遍——
 * 待确认的提议（失败后修好/情况变了/别人的底稿提议）+
 * 已回答但还没沉淀成问答的求助。逐条勾选，不想记的跳过。
 */
function RetroDialog({ taskId, onDone, toast }: { taskId: string; onDone: () => void; toast: (text: string, opts?: Omit<Toast, 'id' | 'text'>) => void }) {
  const [data, setData] = useState<{ offers: LessonOfferView[]; questions: Array<{ id: string; stepId: string | null; bodyMd: string; answerMd: string }> } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api
      .retro(taskId)
      .then(setData)
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
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
        return `失败后改了命令才跑通${at}——记一条问答`
      case 'question':
        return `发起人的回答${at}——记成问答`
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
          <p className="dim">没有待沉淀的候选。这次执行的过程已经都留在记录里了。</p>
        ) : (
          <>
            {data.offers.map((o) => (
              <div key={o.id} className="retro-item">
                <span>{offerText(o)}</span>
                <span className="retro-actions">
                  {(o.kind === 'fix' || o.kind === 'question' || o.kind === 'situation') && (
                    <>
                      <button className="btn primary" disabled={busy === o.id} onClick={() => void act(o.id, () => api.acceptLessonOffer(o.id, { scope: 'team' }))}>
                        记下并共享
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
                  求助「{q.bodyMd.slice(0, 40)}
                  {q.bodyMd.length > 40 ? '…' : ''}」已回答——记成问答
                </span>
                <span className="retro-actions">
                  <button className="btn primary" disabled={busy === q.id} onClick={() => void act(q.id, () => api.questionLesson(q.id, { scope: 'team' }))}>
                    记下并共享
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

/** 单元之间的插入条：悬停时出现，可以插不同种类的块，或从别的任务挑。 */
function InsertBar({ onInsert, onGraft }: { onInsert: (kind: StepKind) => void; onGraft: () => void }) {
  return (
    <div className="insert-bar" title="在这里插入（/）">
      <span className="insert-line" />
      <span className="insert-choices" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => onInsert('command')}>＋ 命令</button>
        <button onClick={() => onInsert('note')}>文字</button>
        <button onClick={() => onInsert('section')}>章节</button>
        <button onClick={() => onInsert('code')}>代码</button>
        <button onClick={() => onInsert('output')}>回显</button>
        <button onClick={onGraft}>挑…</button>
      </span>
    </div>
  )
}

// ── 起草 ──────────────────────────────────────────────────────

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

/**
 * 新任务只要一句"要做什么"。说明、发起人、预期建完了在任务页上补；
 * 怎么开始（自己写 / 导入 md·org / 从别的任务挑 / 让 QB 帮忙）也在任务页选。
 */
function NewTask({ onCreated, onOpenNav }: { onCreated: (t: Task) => void | Promise<void>; onOpenNav: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (title.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const task = await api.createTask({ title: title.trim() })
      setTitle('')
      await onCreated(task)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
          placeholder="要做什么？比如：用 2、3 号卡部署 qwen3.6 27b"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          autoFocus
        />
        <button className="btn primary" onClick={() => void submit()} disabled={busy || title.trim() === ''}>
          创建
        </button>
        <p className="dim">建好以后再选怎么开始：自己写、导入 md/org 笔记、从别的任务挑步骤拼、或者让 QB 帮忙。说明和发起人也在任务页上补。</p>
        {error !== null && <div className="verdict fail">{error}</div>}
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

const COLLAPSE_KEY = 'qb-collapsed'

function loadCollapsed(taskId: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, string[]>
    return new Set(all[taskId] ?? [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(taskId: string, ids: Set<string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, string[]>
    if (ids.size === 0) delete all[taskId]
    else all[taskId] = [...ids]
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all))
  } catch {
    /* 存不下就算了：折叠只是本机的显示偏好 */
  }
}

/**
 * 求助文本（临时 · 复制到 IM）：目标、卡在哪一步、命令、回显尾部、
 * 已经试过什么。发起人不用追问上下文就能回答。secret 参数的值打码。
 */
function askText(task: Task, step: Step | null, evidence: Array<{ text: string | null; imagePath: string | null }>, events: Event[], params: Param[], question?: string): string {
  const secrets = params.flatMap((p) => [...(p.secret ? [p.value] : []), ...(p.fields ?? []).filter((f) => f.secret).map((f) => f.value)]).filter((v) => v.length >= 3)
  const mask = (t: string): string => secrets.reduce((acc, v) => acc.split(v).join('***'), t)
  const lines = [`【求助】${task.title}`]
  if (question !== undefined && question.trim() !== '') lines.push(`问题：${question.trim()}`)
  if (step !== null) {
    lines.push(`${question !== undefined ? '在这一步' : '卡在'}：${step.title}${step.statusNote !== null ? `（${step.statusNote}）` : ''}`)
    if (step.command !== null && step.kind !== 'note') lines.push(`命令：${step.command}`)
    const last = [...evidence].reverse().find((e) => e.text !== null)
    if (last?.text != null) {
      const tail = last.text.trim().split('\n').slice(-15).join('\n')
      lines.push(`现象（回显尾部）：\n${tail}`)
    }
    if (evidence.some((e) => e.imagePath !== null)) lines.push('（我这边还有截图，需要的话发你）')

    if (question === undefined) {
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
  }
  lines.push('—— QB 整理')
  return mask(lines.join('\n'))
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
  bodyMd: '正文',
  lang: '语言',
  refMd: '参考回显',
  expectation: '预期',
  expectedMinutes: '预计耗时',
  kind: '类型',
  status: '状态',
  params: '参数',
}

const TASK_FIELD: Record<string, string> = {
  title: '标题',
  briefMd: '说明',
  initiatorId: '发起人',
  expectedMinutes: '预计耗时',
  definitionOfDone: '完成标准',
}

function eventText(e: Event, steps: Step[]): string {
  const payload = e.payload
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  const ms = typeof payload.durationMs === 'number' ? ` (${formatMs(payload.durationMs)})` : ''
  const title = typeof payload.title === 'string' ? payload.title : (steps.find((s) => s.id === e.stepId)?.title ?? '')
  const which = title !== '' ? `「${title}」` : '这一步'
  const byQb = payload.by === 'qb'

  switch (e.kind) {
    case 'task_created':
      return typeof payload.by === 'string' && payload.by !== '' && payload.remote === true ? `${payload.by} 派来了这个任务` : '创建了任务'
    case 'task_updated': {
      const fields = Array.isArray(payload.fields) ? (payload.fields as string[]).map((f) => TASK_FIELD[f] ?? f) : []
      if (typeof payload.initiator === 'string') return `发起人改成了 ${payload.initiator}`
      return `改了任务的${fields.join('、') || '信息'}`
    }
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
      if (payload.lines !== undefined && typeof payload.lines === 'object' && payload.lines !== null) {
        const l = payload.lines as { from?: number; to?: number }
        return `运行了${which}的第 ${l.from}–${l.to} 行`
      }
      return payload.watch === 'only' ? `QB 开始盯着${which}` : payload.watch === 'run' ? `运行并盯着${which}` : `开始执行${which}`
    case 'step_ok':
      if (payload.source === 'delegate') return `${which}完成了（${typeof payload.by === 'string' ? payload.by : '对方'}做完了委派）`
      return payload.source === 'image' && byQb ? `QB 看了截图：${which}通过${reason !== '' ? ` — ${reason}` : ''}` : `${which}通过${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_failed':
      if (typeof payload.diagnosis === 'string') return `QB 诊断${which}：${payload.diagnosis}`
      return payload.source === 'image' && byQb ? `QB 看了截图：${which}没通过${reason !== '' ? ` — ${reason}` : ''}` : `${which}失败${ms}${reason !== '' ? ` — ${reason}` : ''}`
    case 'step_timeout':
      return `${which}超时${ms}`
    case 'step_skipped':
      return `跳过了${which}${reason !== '' ? `：${reason}` : ''}`
    case 'edit': {
      if (payload.renamedParam !== undefined && typeof payload.renamedParam === 'object' && payload.renamedParam !== null) {
        const r = payload.renamedParam as { from?: string; to?: string }
        return `参数 ${r.from} 改名为 ${r.to}`
      }
      if (Array.isArray(payload.paramChanges)) {
        const names = (payload.paramChanges as Array<{ name: string }>).map((c) => c.name)
        return `改了参数 ${names.join('、')}`
      }
      if (e.stepId === null) return '改了参数'
      const changes = Array.isArray(payload.changes) ? (payload.changes as Array<{ field: string }>) : []
      const fields = [...new Set(changes.map((c) => FIELD_LABEL[c.field] ?? c.field).filter((f) => f !== '超时' && f !== 'titleAuto'))]
      return `改了${which}的${fields.join('、') || '内容'}`
    }
    case 'insert':
      return typeof payload.from === 'string' && payload.from !== '' ? `从「${payload.from}」接过来${which}` : `插入${which}`
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
      return typeof payload.lessonId === 'string' ? '把一条问答拿去问了发起人' : '发出了求助（已通知发起人）'
    case 'question_answered': {
      const by = typeof payload.by === 'string' ? payload.by : '发起人'
      const answer = typeof payload.answer === 'string' ? payload.answer : ''
      return `${by} 回答了：${answer}`
    }
    case 'alert_acked':
      return '发起人知道了'
    case 'lesson_proposed':
      return payload.shared === true ? `记了一条问答（已共享给团队）：${String(payload.symptom ?? '')}` : `记了一条问答：${String(payload.symptom ?? '')}`
    case 'lesson_confirmed':
      return payload.status === 'confirmed' ? `${typeof payload.by === 'string' && payload.by !== '' ? payload.by : '发起人'} 确认了一条问答` : `一条问答被判定无效，降回只给自己`
    case 'lesson_shared': {
      const by = typeof payload.by === 'string' ? payload.by : '同事'
      const symptom = typeof payload.symptom === 'string' ? payload.symptom : ''
      return `${by} 在这里记了一条问答：${symptom}`
    }
    case 'base_proposal': {
      const from = typeof payload.from === 'string' && payload.from !== '' ? payload.from : null
      const t = typeof payload.stepTitle === 'string' ? payload.stepTitle : '某一步'
      if (payload.sent === true) return `把「${t}」的改动发给底稿负责人`
      if (payload.applied === 'accepted') return `底稿提议已应用：「${t}」`
      if (payload.applied === 'conflict') return `底稿提议冲突（自己的命令已改过）：「${t}」`
      if (payload.decided !== undefined) return `${typeof payload.by === 'string' && payload.by !== '' ? payload.by : '对方'}处理了你的底稿提议（${String(payload.decided)}）`
      return `${from !== null ? from : '同事'} 提议把「${t}」的命令改回底稿`
    }
    default:
      return e.kind
  }
}

