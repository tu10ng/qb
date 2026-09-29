import { useEffect, useMemo, useRef, useState } from 'react'
import type { Event, Evidence, Expectation, Param, Step, StepKind } from '@qb/core'
import {
  codeTitle,
  diffLines,
  isContent,
  isRunnable,
  isSection,
  isTemplated,
  noteTitle,
  pickLines,
  renderCommand,
  splitShellCommands,
  type MoveDirection,
} from '@qb/core'
import {
  ApiError,
  api,
  evidenceImageUrl,
  type Delegation,
  type DelegationMirror,
  type Diagnosis,
  type FidelityView,
  type Job,
  type LessonOfferView,
  type NewStepInput,
  type QaItem,
  type StepOutputs,
  type StepPatchInput,
  type TeamUser,
} from './api.ts'
import { AutoTextarea, CodeEditor, CodeView, templateHtml, type LineRange } from './CodeBlock.tsx'
import { Editable } from './Editable.tsx'
import { highlightHtml, LANGUAGE_CHOICES, renderMarkdown } from './highlight.ts'

export interface StepRunState {
  output: string
  running: boolean
  verdict?: 'pass' | 'fail' | 'unclear'
  reason?: string
  durationMs?: number
  redactionHits?: string[]
  /** 只运行了选中的几行。 */
  partial?: boolean
}

/** 单元对 runbook 的操作都交给上层：它负责撤销记录与刷新。 */
export interface StepActions {
  edit(patch: StepPatchInput): Promise<void>
  /** 在它下面插一个块（章节里就插进章节）。 */
  insertAfter(kind?: StepKind): void
  remove(): void
  move(dir: MoveDirection): void
  setStatus(status: 'pending' | 'ok' | 'failed' | 'skipped', note?: string): void
  /** 把这一块拆开：第一段留在这一块（它可能从命令变成文字），其余依次插在后面（整体一次撤销）。 */
  split(parts: NewStepInput[]): void
  uploadImage(file: File): void
  /** 委派给别人：经团队服务派给对方（需要团队同步）。 */
  delegate(input: { assigneeName: string; displayName?: string; note?: string }): Promise<void>
  /** 命令里写了却没声明的参数：一键声明（值先空着）。 */
  declareParams(names: string[]): void
  /** 贴进来一行机器信息（IP 用户 密码）：存成机器参数，命令里换成引用。 */
  addMachine(text: string): Promise<string | null>
  /** 点命令里的参数：去参数面板改它。 */
  focusParam(name: string): void
  /** 在这一步上记一条问答（问和答可以只填一个）。 */
  addQa(): void
  /** 问发起人（带上这一步的上下文）。 */
  ask(): void
}

interface Props {
  step: Step
  /** 整份文档（算层级、找子节点）。 */
  steps: Step[]
  depth: number
  current: boolean
  /** 章节折叠了。 */
  collapsed: boolean
  onToggleCollapse: () => void
  runState: StepRunState | undefined
  /** 历史证据（上次跑的输出、手动贴的内容、截图）。 */
  evidence: Evidence[]
  /** 当前参数表：命令显示的是渲染值，编辑改的是模板。 */
  params: Param[]
  /** 这一步的保真检查结果（导入来的 runbook 才有）。 */
  fidelity: FidelityView['items'][number] | undefined
  /** 这一步上正在跑的后台任务（QB 在看截图）。 */
  job: Job | undefined
  /** 最近一次内容编辑，悬停"我改的"时显示改前改后。 */
  lastEdit: Event | undefined
  /** 刚插入的新块：直接进入编辑。 */
  autoEdit: boolean
  canMove: Record<MoveDirection, boolean>
  /** 挂在这一步上的问答。 */
  qa: QaItem[]
  /** 挂在这一步上的捕获提议（失败后修好 / 偏离底稿）。 */
  offers?: LessonOfferView[]
  /** 发起人/同事在这一步上的评论。 */
  comments?: Event[]
  /** 委派出去的步骤：交给了谁、对方进度。 */
  delegation?: Delegation | undefined
  /** wait 步骤"盯着"时的最近一次探测。 */
  probe?: { attempt: number; detail: string } | undefined
  /** 团队里的人（委派选人）；没配团队时为空。 */
  teamUsers?: TeamUser[]
  teamEnabled?: boolean
  actions: StepActions
  onFocus: () => void
  onChanged: () => void
}

/** 能手动切换的块类型（委派要走"委派给…"，章节层级走 Tab）。 */
const KIND_LABEL: Record<Exclude<StepKind, 'delegate'>, string> = {
  command: '命令',
  check: '检查',
  wait: '等待就绪',
  manual: '人工',
  decision: '需要拍板',
  section: '章节',
  note: '文字',
  code: '代码',
  output: '回显',
}

/**
 * 一个块。runbook 是可以执行的手册，块有两类：
 * - 文档内容：章节（任意层、能折叠）、文字（markdown）、代码（复制用）、回显
 * - 要做的步骤：命令、检查、等待、人工、拍板、委派（有完成/跳过/失败）
 *
 * 产品宪法在这里的落点：一切细节原地可见；点即编辑；不当保姆（运行、复制、
 * 手动跑后粘贴、直接标完成随用户）；破坏性命令红框 + 内联确认，不弹窗。
 */
export function StepCell(props: Props) {
  const { step } = props
  if (isSection(step)) return <SectionHead {...props} />
  if (step.kind === 'note') return <NoteBlock {...props} />
  if (step.kind === 'code' || step.kind === 'output') return <SnippetBlock {...props} />
  if (step.kind === 'delegate') return <DelegateBlock {...props} />
  return <StepBody {...props} />
}

const indent = (depth: number): React.CSSProperties => ({ marginLeft: depth * 18 })

// ── 章节 ────────────────────────────────────────────────────

function SectionHead({ step, steps, depth, current, collapsed, onToggleCollapse, autoEdit, canMove, qa, actions, onFocus }: Props) {
  const [error, setError] = useState<string | null>(null)
  const kids = countDoable(steps, step.id)
  return (
    <div className={`section-head level-${Math.min(depth, 3)}${current ? ' current' : ''}`} style={indent(depth)} onClick={onFocus}>
      <button
        className="fold"
        title={collapsed ? '展开这一章' : '折叠这一章'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleCollapse()
        }}
      >
        {collapsed ? '▸' : '▾'}
      </button>
      <span className="section-name">
        <Editable
          value={step.title}
          autoEdit={autoEdit}
          onSave={(title) =>
            actions
              .edit({ title })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }
        />
      </span>
      {collapsed && kids.total > 0 && (
        <span className="dim">
          {kids.done}/{kids.total}
        </span>
      )}
      {qa.length > 0 && <span className="qa-count" title="这一章上的问答">？{qa.length}</span>}
      {error !== null && <span className="verdict fail">{error}</span>}
      <span className="spacer" />
      <MoreMenu step={step} canMove={canMove} actions={actions} />
    </div>
  )
}

function countDoable(steps: Step[], rootId: string): { done: number; total: number } {
  const inside = new Set([rootId])
  let done = 0
  let total = 0
  for (const s of steps) {
    if (s.parentId === null || !inside.has(s.parentId)) continue
    inside.add(s.id)
    if (isContent(s)) continue
    total++
    if (s.status === 'ok' || s.status === 'skipped') done++
  }
  return { done, total }
}

// ── 文字 ────────────────────────────────────────────────────

function NoteBlock({ step, depth, current, autoEdit, canMove, qa, actions, onFocus, onChanged }: Props) {
  const [editing, setEditing] = useState(autoEdit)
  const [draft, setDraft] = useState(step.bodyMd ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!editing) setDraft(step.bodyMd ?? '')
  }, [step.bodyMd, editing])

  const html = useMemo(() => renderMarkdown(step.bodyMd ?? ''), [step.bodyMd])
  const save = (): void => {
    setEditing(false)
    const next = draft.replace(/\s+$/, '')
    if (next === (step.bodyMd ?? '')) return
    actions.edit({ bodyMd: next === '' ? null : next }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className={`block note${current ? ' current' : ''}`} style={indent(depth)} onClick={onFocus}>
      <div className="block-gutter">
        <MoreMenu step={step} canMove={canMove} actions={actions} />
      </div>
      {editing ? (
        <div onClick={(e) => e.stopPropagation()}>
          <AutoTextarea
            autoFocus
            className="note-edit"
            value={draft}
            minRows={2}
            placeholder="写点什么：说明、链接、参考资料（markdown；截图直接 Ctrl+V）"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onPaste={(e) => {
              const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
              if (file === undefined) return
              e.preventDefault()
              e.stopPropagation()
              const el = e.currentTarget
              const at = el.selectionStart
              void uploadInline(file)
                .then((url) => setDraft((d) => `${d.slice(0, at)}![截图](${url})${d.slice(at)}`))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setDraft(step.bodyMd ?? '')
                setEditing(false)
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                save()
              }
            }}
          />
          <div className="dim">Ctrl+Enter 保存 · Esc 取消 · 支持 markdown：**粗体**、[链接](地址)、- 列表、表格、```代码```</div>
        </div>
      ) : (step.bodyMd ?? '') === '' ? (
        <div
          className="md empty"
          onClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
        >
          空白的文字块——点这里写
        </div>
      ) : (
        <div
          className="md"
          title="点击编辑"
          onClick={(e) => {
            // 点链接、选文字不进编辑
            if ((e.target as HTMLElement).closest('a') !== null) return
            if ((window.getSelection()?.toString() ?? '') !== '') return
            e.stopPropagation()
            onFocus()
            setEditing(true)
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <QaInline items={qa} step={step} onChanged={onChanged} actions={actions} failed={false} />
      {error !== null && <div className="verdict fail">{error}</div>}
    </div>
  )
}

async function uploadInline(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error(`图片太大（${Math.round(file.size / 1024)} KB），上限 5 MB`)
  const dataUrl = await readAsDataUrl(file)
  return api.uploadAttachment(dataUrl, file.type)
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('读不了这个文件'))
    r.readAsDataURL(file)
  })
}

// ── 代码 / 回显 ──────────────────────────────────────────────

function SnippetBlock({ step, depth, current, autoEdit, canMove, params, qa, actions, onFocus, onChanged }: Props) {
  const [editing, setEditing] = useState(autoEdit)
  const [draft, setDraft] = useState(step.command ?? '')
  const [folded, setFolded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lines, setLines] = useState<LineRange | null>(null)
  useEffect(() => {
    if (!editing) setDraft(step.command ?? '')
  }, [step.command, editing])

  const templated = isTemplated(step)
  const text = step.command ?? ''
  const html = useMemo(() => (templated ? templateHtml(text, params, step.lang) : highlightHtml(text, step.lang)), [templated, text, params, step.lang])
  const lineCount = text.split('\n').length

  const copy = (range: LineRange | null): void => {
    const body = range === null ? text : pickLines(text, range.from, range.to)
    void navigator.clipboard.writeText(templated ? renderCommand(body, params).text : body)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={`block snippet ${step.kind}${current ? ' current' : ''}`} style={indent(depth)} onClick={onFocus}>
      <div className="snippet-head" onClick={(e) => e.stopPropagation()}>
        <button className="fold" title={folded ? '展开' : '折叠'} onClick={() => setFolded((v) => !v)}>
          {folded ? '▸' : '▾'}
        </button>
        <span className="snippet-kind">{step.kind === 'output' ? '回显' : '代码'}</span>
        <LangPicker value={step.lang} onChange={(lang) => void actions.edit({ lang })} />
        {!step.titleAuto && <span className="snippet-title">{step.title}</span>}
        {folded && <span className="dim">{lineCount} 行</span>}
        <span className="spacer" />
        {lines !== null && (
          <button className="btn ghost" onClick={() => copy(lines)}>
            ⧉ 复制第 {lines.from}–{lines.to} 行
          </button>
        )}
        <button className="btn ghost" onClick={() => copy(null)}>
          {copied ? '已复制' : '⧉ 复制'}
        </button>
        <MoreMenu step={step} canMove={canMove} actions={actions} />
      </div>
      {!folded &&
        (editing ? (
          <CodeEditor
            value={draft}
            lang={step.lang}
            placeholder={step.kind === 'output' ? '贴一段回显 / 日志' : '贴一段代码或配置'}
            onChange={setDraft}
            onCancel={() => {
              setDraft(step.command ?? '')
              setEditing(false)
            }}
            onCommit={() => {
              setEditing(false)
              const next = draft.replace(/\s+$/, '')
              if (next !== (step.command ?? '')) void actions.edit({ command: next === '' ? null : next })
            }}
          />
        ) : (
          <CodeView
            html={text === '' ? '<span class="dim">（空）点这里写</span>' : html}
            className={step.kind === 'output' ? 'output-view' : ''}
            onSelectLines={setLines}
            onClick={(e) => {
              if ((window.getSelection()?.toString() ?? '') !== '') return
              e.stopPropagation()
              onFocus()
              setEditing(true)
            }}
          />
        ))}
      <QaInline items={qa} step={step} onChanged={onChanged} actions={actions} failed={false} />
    </div>
  )
}

/** 语言选择：显示当前语言，点开改（类似 markdown 围栏上的语言标记）。 */
function LangPicker({ value, onChange }: { value: string | null; onChange: (lang: string | null) => void }) {
  const known = value === null || LANGUAGE_CHOICES.some((l) => l.id === value)
  return (
    <select className="lang-pick" value={value ?? ''} title="语言（决定高亮）" onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      <option value="">自动</option>
      {!known && <option value={value!}>{value}</option>}
      {LANGUAGE_CHOICES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

// ── 委派行 ──────────────────────────────────────────────────

function DelegateBlock({ step, depth, current, runState, canMove, actions, onFocus, delegation, teamUsers, comments }: Props) {
  return (
    <div className={`step${current ? ' current' : ''}`} style={indent(depth)} onClick={onFocus}>
      <div className="step-head">
        <span className={`step-mark ${markClass(step, runState?.running ?? false)}`}>{mark(step, runState?.running ?? false)}</span>
        <span className="step-title">{step.title}</span>
        <span className="step-hint">{hintTail(step, runState)}</span>
        <MoreMenu step={step} canMove={canMove} actions={actions} delegated={delegation !== undefined} />
      </div>
      {step.whyMd !== null && <div className="step-why">{step.whyMd}</div>}
      <div className="step-body">
        <DelegationRow
          step={step}
          delegation={delegation}
          displayName={teamUsers?.find((u) => u.name === delegation?.assigneeName)?.displayName ?? delegation?.assigneeName ?? ''}
        />
        <StepComments comments={comments} />
      </div>
    </div>
  )
}

// ── 要做的步骤 ──────────────────────────────────────────────

function StepBody({
  step,
  depth,
  current,
  runState,
  evidence,
  params,
  fidelity,
  job,
  lastEdit,
  autoEdit,
  canMove,
  qa,
  offers,
  comments,
  probe,
  teamUsers,
  teamEnabled,
  actions,
  onFocus,
  onChanged,
}: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [danger, setDanger] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [noteFor, setNoteFor] = useState<'skipped' | 'failed' | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [cmdEditing, setCmdEditing] = useState(false)
  const [cmdDraft, setCmdDraft] = useState(step.command ?? '')
  const [cmdFolded, setCmdFolded] = useState(false)
  const [lines, setLines] = useState<LineRange | null>(null)
  const [pasteOffer, setPasteOffer] = useState<PasteOffer | null>(null)
  const [copied, setCopied] = useState(false)
  const [refOpen, setRefOpen] = useState(false)
  // 拆步 / 存成机器参数时编辑框会被收起：收起引发的失焦不能再把整段原文存回去
  const suppressCommit = useRef(false)

  // 命令改了，之前那条命令的破坏性确认就不作数了
  useEffect(() => {
    setDanger(null)
    setConfirmed(false)
    setLines(null)
  }, [step.command])
  useEffect(() => {
    if (!cmdEditing) setCmdDraft(step.command ?? '')
    // 新开一次编辑：上一次"收起不保存"的标记作废（元素被移除时浏览器不一定发 blur）
    else suppressCommit.current = false
  }, [step.command, cmdEditing])
  // 新插入的命令步骤：直接进命令编辑（标题是按内容自动取的，不用先起名字）
  useEffect(() => {
    if (autoEdit && step.titleAuto) setCmdEditing(true)
  }, [autoEdit, step.titleAuto])

  const running = runState?.running ?? false
  const texts = evidence.filter((e) => e.imagePath === null)
  const images = evidence.filter((e) => e.imagePath !== null)
  // 本次运行的实时输出优先；没有就显示历史证据。
  // 只收到状态变化（手动贴证据也会推 step.status）时 output 是空串，不能拿它盖掉历史证据
  const lastText = texts.length > 0 ? texts[texts.length - 1]! : null
  const liveOutput = runState !== undefined && (runState.running || runState.output !== '') ? runState.output : null
  const shownOutput = liveOutput ?? lastText?.text ?? null
  const judging = job?.kind === 'judge' && job.status === 'running'
  const judgeFailed = job?.kind === 'judge' && job.status === 'failed' ? job.error : null
  const failed = step.status === 'failed' || runState?.verdict === 'fail'

  const run = async (range: LineRange | null = null): Promise<void> => {
    setError(null)
    try {
      await api.runStep(step.id, { ...(confirmed ? { confirmed: true } : {}), ...(range !== null ? { lines: range } : {}) })
      onChanged()
    } catch (e) {
      if (e instanceof ApiError && e.needsConfirmation) {
        // 不弹窗：亮红框，用户点一下内联开关再运行
        setDanger(e.matched)
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const submit = async (input: { text?: string; markDone?: boolean }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.submitEvidence(step.id, input)
      setDraft('')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const edit = (patch: StepPatchInput): void => {
    setError(null)
    actions.edit(patch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const commitCommand = (): void => {
    setCmdEditing(false)
    if (suppressCommit.current) {
      suppressCommit.current = false
      return
    }
    const next = cmdDraft.replace(/\s+$/, '')
    if (next !== (step.command ?? '')) edit({ command: next === '' ? null : next })
  }

  /**
   * 粘贴进命令框：先照常贴进去（原先直接关掉编辑框、命令还是空的，像没贴
   * 上）。贴的是好几条命令、或者命令混着说明文字、或者一行机器信息，就在
   * 下面问一句要不要拆 / 存成参数——不问也行，贴进去的就在那里。
   */
  const onPasteCommand = (text: string, e: React.ClipboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget
    const before = cmdDraft.slice(0, el.selectionStart)
    const after = cmdDraft.slice(el.selectionEnd)
    const merged = `${before}${text}${after}`
    setCmdDraft(merged)
    requestAnimationFrame(() => {
      const at = before.length + text.length
      el.setSelectionRange(at, at)
    })
    setPasteOffer(pasteOfferFor(text, before.trim() === '' && after.trim() === ''))
    return true
  }

  const isDangerous = danger !== null
  const template = step.command ?? ''
  const rendered = step.command !== null ? renderCommand(step.command, params) : { text: '', missing: [] as string[], undeclared: [] as string[] }
  // 缺值与写错名字的（未声明）参数都挡运行
  const blockedParams = [...rendered.missing, ...rendered.undeclared]
  const badge = originBadge(step, lastEdit)
  // wait 步骤带就绪条件：运行即"运行并盯着"，就绪了自动打勾
  const isWatch = step.kind === 'wait' && step.probe !== null
  const runnable = isRunnable(step)
  const cmdHtml = useMemo(() => templateHtml(template, params, step.lang ?? 'bash'), [template, params, step.lang])
  const lineCount = template === '' ? 0 : template.split('\n').length

  const copy = (range: LineRange | null): void => {
    const body = range === null ? template : pickLines(template, range.from, range.to)
    void navigator.clipboard.writeText(renderCommand(body, params).text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div
      className={`step${current ? ' current' : ''}${dragOver ? ' drag-image' : ''}${failed ? ' failed-cell' : ''}`}
      style={indent(depth)}
      onClick={onFocus}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
        setDragOver(false)
        if (file === undefined) return
        e.preventDefault()
        actions.uploadImage(file)
      }}
    >
      <div className="step-head">
        <span className={`step-mark ${markClass(step, running)}`}>{mark(step, running)}</span>
        <span className={`step-title${step.titleAuto ? ' auto' : ''}`}>
          <Editable
            value={step.titleAuto ? '' : step.title}
            autoEdit={autoEdit && !step.titleAuto}
            placeholder="＋ 起个名字（可选）"
            showPlaceholder={step.titleAuto}
            onSave={(title) => edit(title === '' ? { titleAuto: true } : { title })}
          />
        </span>
        {step.kind !== 'command' && <span className="kind-tag">{KIND_LABEL[step.kind as Exclude<StepKind, 'delegate'>]}</span>}
        {badge !== null && (
          <span className={`origin-badge ${badge.cls}`} title={badge.title}>
            {badge.label}
          </span>
        )}
        {step.shareOutput && (
          <span className="origin-badge" title="这一步的最新输出（脱敏、截尾 4KB）会随同步给发起人看">
            输出已共享
          </span>
        )}
        <span className="step-hint">
          <Editable
            value={step.expectedMinutes === null ? '' : String(step.expectedMinutes)}
            placeholder="预计耗时"
            showPlaceholder={current}
            display={(v) => `预计 ${formatMinutes(Number(v))}`}
            onSave={(v) => {
              const m = Number(v)
              if (v === '') edit({ expectedMinutes: null })
              else if (Number.isFinite(m) && m > 0) edit(minutesPatch(m))
              else setError('预计耗时要填分钟数，比如 5 或 0.5')
            }}
          />
          {hintTail(step, runState)}
        </span>
        <MoreMenu step={step} canMove={canMove} actions={actions} teamUsers={teamUsers ?? []} teamEnabled={teamEnabled === true} />
      </div>

      {(step.whyMd !== null || current) && (
        <div className="step-why">
          <Editable
            value={step.whyMd ?? ''}
            multiline
            placeholder="为什么要做这一步（一句话，可选）"
            showPlaceholder={current}
            onSave={(v) => edit({ whyMd: v === '' ? null : v })}
          />
          {step.whySource !== null && <span className="source"> — {step.whySource}</span>}
        </div>
      )}

      <div className="step-body">
        {(step.command !== null || current || cmdEditing) && step.kind !== 'manual' && step.kind !== 'decision' && (
          <div className={`cmd${isDangerous ? ' destructive' : ''}${step.command === null && !cmdEditing ? ' placeholder' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="cmd-head">
              {step.command !== null && (
                <button className="fold" title={cmdFolded ? '展开命令' : '折叠命令'} onClick={() => setCmdFolded((v) => !v)}>
                  {cmdFolded ? '▸' : '▾'}
                </button>
              )}
              <LangPicker value={step.lang} onChange={(lang) => edit({ lang })} />
              {cmdFolded && <span className="dim">{lineCount} 行</span>}
              <span className="spacer" />
              {step.command !== null && !cmdEditing && (
                <span className="actions">
                  {lines !== null && (
                    <>
                      {runnable && (
                        <button className="btn" disabled={running || (isDangerous && !confirmed)} onClick={() => void run(lines)} title="只运行选中的几行（不判定、不改这一步的状态）">
                          ▶ 第 {lines.from}–{lines.to} 行
                        </button>
                      )}
                      <button className="btn" onClick={() => copy(lines)}>
                        ⧉ 第 {lines.from}–{lines.to} 行
                      </button>
                    </>
                  )}
                  {runnable && (
                    <button
                      className="btn primary"
                      title={blockedParams.length > 0 ? `缺参数：${blockedParams.join('、')}` : undefined}
                      onClick={() => void run()}
                      disabled={running || (isDangerous && !confirmed) || blockedParams.length > 0}
                    >
                      {running ? (isWatch ? '盯着中' : '运行中') : isWatch ? '▶ 运行并盯着' : '▶ 运行'}
                    </button>
                  )}
                  <button className="btn" onClick={() => copy(null)}>
                    {copied ? '已复制' : '⧉ 复制'}
                  </button>
                </span>
              )}
            </div>
            {!cmdFolded &&
              (cmdEditing ? (
                <CodeEditor
                  value={cmdDraft}
                  lang={step.lang ?? 'bash'}
                  placeholder="贴命令；参数写成 {{名字}}，如 {{容器名}}（Ctrl+Enter 保存）"
                  onChange={setCmdDraft}
                  onPaste={onPasteCommand}
                  onCancel={() => {
                    setCmdDraft(step.command ?? '')
                    setCmdEditing(false)
                    setPasteOffer(null)
                  }}
                  onCommit={commitCommand}
                />
              ) : step.command === null ? (
                <div
                  className="cmd-empty"
                  onClick={() => {
                    onFocus()
                    setCmdEditing(true)
                  }}
                >
                  ＋ 命令
                </div>
              ) : (
                <CodeView
                  html={cmdHtml}
                  onSelectLines={lineCount > 1 ? setLines : undefined}
                  onClick={(e) => {
                    const param = (e.target as HTMLElement).closest('[data-param]')
                    if (param !== null) {
                      e.stopPropagation()
                      actions.focusParam(param.getAttribute('data-param')!)
                      return
                    }
                    if ((window.getSelection()?.toString() ?? '') !== '') return
                    onFocus()
                    setCmdEditing(true)
                  }}
                />
              ))}
          </div>
        )}

        {pasteOffer !== null && (
          <PasteOfferBar
            offer={pasteOffer}
            onSplit={() => {
              // 用编辑框里现在的内容拆（可能又改过）
              const parts = pasteParts(cmdDraft)
              setPasteOffer(null)
              if (parts.length < 2) return
              if (cmdEditing) suppressCommit.current = true
              setCmdEditing(false)
              actions.split(parts)
            }}
            onMachine={() => {
              setPasteOffer(null)
              if (cmdEditing) suppressCommit.current = true
              setCmdEditing(false)
              void actions.addMachine(cmdDraft).then(() => setCmdDraft(step.command ?? ''))
            }}
            onDismiss={() => setPasteOffer(null)}
          />
        )}

        {step.command !== null && blockedParams.length > 0 && (
          <div className="cmd-note" onClick={(e) => e.stopPropagation()}>
            {rendered.undeclared.length > 0 ? (
              <>
                命令里用到了还没声明的参数：{rendered.undeclared.join('、')}{' '}
                <button className="btn ghost" onClick={() => actions.declareParams(rendered.undeclared.filter((r) => !r.includes('.')))}>
                  声明为参数
                </button>
              </>
            ) : (
              <>
                缺参数：{rendered.missing.join('、')}{' '}
                <button className="btn ghost" onClick={() => actions.focusParam(rendered.missing[0]!.split('.')[0]!)}>
                  去填
                </button>
              </>
            )}
          </div>
        )}

        {step.command !== null && fidelity !== undefined && !fidelity.verbatim && !fidelity.unverified && (
          <div className="cmd-note fidelity" onClick={(e) => e.stopPropagation()}>
            QB 改写过（与素材原文不一致）
            {fidelity.closest !== null && (
              <>
                {' '}
                <button
                  className="btn ghost"
                  onClick={() => {
                    if (window.confirm(`用素材原文替换这条命令？\n${fidelity.closest}`)) {
                      edit({ command: fidelity.closest! })
                    }
                  }}
                >
                  用原文
                </button>
              </>
            )}
          </div>
        )}
        {step.command !== null && fidelity?.unverified === true && <div className="cmd-note">参数缺值，没法跟素材原文核对</div>}

        {isDangerous && (
          <div className="danger-note">
            <span>⚠ {danger.join('、')}</span>
            <label onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              我确认要运行
            </label>
          </div>
        )}

        {/* 问答：条件成立的一行预警；不成立/判定不了/疑似过期的折叠；失败时全部展开 */}
        <QaInline items={qa} step={step} onChanged={onChanged} actions={actions} failed={failed} />

        {/* 捕获提议：失败后修好 / 偏离底稿，预填好等人点 */}
        {(offers ?? [])
          .filter((o) => o.kind === 'fix' || o.kind === 'deviation')
          .map((o) => (
            <CaptureCard key={o.id} offer={o} onChanged={onChanged} />
          ))}

        {step.probe !== null && (
          <div className="expectation" onClick={(e) => e.stopPropagation()}>
            <span className="label">就绪条件：</span>
            {describeProbe(step.probe)}
            {running && probe !== undefined && (
              <div className="probe-line">
                QB 在盯着 · 第 {probe.attempt} 次探测：{probe.detail} · 你先看下一步
              </div>
            )}
            {!running && step.status !== 'ok' && step.probe.kind !== 'logPattern' && (
              <div className="probe-line">
                <button
                  className="btn"
                  onClick={() => {
                    setError(null)
                    api
                      .watchStep(step.id)
                      .then(onChanged)
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  }}
                >
                  👀 只盯着
                </button>{' '}
                <span className="dim">命令在 SecureCRT/Xshell 里跑的话点这个：QB 在本机轮询，就绪了自动打勾</span>
              </div>
            )}
          </div>
        )}

        {(step.expectation !== null || current) && (
          <div className="expectation">
            <span className="label">预期：</span>
            <Editable
              value={step.expectation === null ? '' : expectationText(step.expectation)}
              placeholder="怎么知道这步成了（输出里会出现的字样，或人工判断标准）"
              display={() => (step.expectation === null ? '' : describeExpectation(step.expectation))}
              onSave={(v) => edit({ expectation: withExpectationText(step.expectation, v, step.kind) })}
            />
          </div>
        )}

        {/* 参考回显：跑完应该看到什么（随手册复制；每次运行都能拿它比） */}
        {(step.refMd !== null || refOpen) && (
          <ReferenceOutput step={step} open={refOpen} onClose={() => setRefOpen(false)} onSave={(refMd) => edit({ refMd })} />
        )}

        {shownOutput !== null && (
          <div className="output">
            <span className="label">
              输出{lastText !== null && liveOutput === null ? `（${sourceLabel(lastText.source)}）` : ''}：
            </span>
            <div className="output-box">
              {shownOutput}
              {running && '▌'}
            </div>
            {runState?.verdict !== undefined && (
              <div className={`verdict ${runState.partial === true ? 'unclear' : runState.verdict}`}>
                {runState.partial === true ? '只运行了几行' : verdictLabel(runState.verdict)} · {runState.reason}
                {runState.durationMs !== undefined && ` · ${formatMs(runState.durationMs)}`}
              </div>
            )}
            {(runState?.redactionHits?.length ?? 0) > 0 && <div className="paste-hint">已脱敏：{runState!.redactionHits!.join('、')}</div>}
            {lastText?.redacted === true && liveOutput === null && <div className="paste-hint">已脱敏</div>}
          </div>
        )}

        {(texts.length > 0 || step.lineageKey !== null) && current && <OutputHistory step={step} evidenceCount={texts.length} onChanged={onChanged} />}

        {images.length > 0 && (
          <div className="shots" onClick={(e) => e.stopPropagation()}>
            {images
              .slice()
              .reverse()
              .map((img) => (
                <a key={img.id} href={evidenceImageUrl(img.id)} target="_blank" rel="noreferrer" className="shot">
                  <img src={evidenceImageUrl(img.id)} alt="截图证据" loading="lazy" />
                  {img.text !== null && <span className="caption">{img.text}</span>}
                </a>
              ))}
          </div>
        )}
        {judging && <div className="paste-hint">QB 在看截图……</div>}
        {judgeFailed !== null && <div className="verdict unclear">没能看截图：{judgeFailed}</div>}

        {/* 手动跑完可以贴回来——文本或截图都行 */}
        {!running && current && (
          <div onClick={(e) => e.stopPropagation()}>
            <AutoTextarea
              className="inline-edit paste-box"
              placeholder={
                step.command !== null
                  ? '自己在终端里跑的话，把回显粘贴到这里（截图直接 Ctrl+V 或拖进来）'
                  : '做完了？可以写点什么，或贴一张截图（可选）'
              }
              value={draft}
              maxHeight={320}
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft !== '' && (
              <button className="btn primary" style={{ marginTop: 5 }} disabled={busy} onClick={() => void submit({ text: draft })}>
                提交回显
              </button>
            )}
          </div>
        )}

        <StepComments comments={comments} />

        {step.statusNote !== null && (step.status === 'skipped' || step.status === 'failed') && (
          <div className={`verdict ${step.status === 'failed' ? 'fail' : 'unclear'}`}>
            {step.status === 'skipped' ? '已跳过' : '标记失败'}：{step.statusNote}
          </div>
        )}

        {error !== null && <div className="verdict fail">{error}</div>}

        {/* 失败了就让 QB 看看——这是"流程不能停"的落点 */}
        {failed && <DiagnosePanel stepId={step.id} onApplied={onChanged} />}

        {current &&
          (noteFor !== null ? (
            <NoteForm
              kind={noteFor}
              onCancel={() => setNoteFor(null)}
              onSubmit={(note) => {
                actions.setStatus(noteFor, note)
                setNoteFor(null)
              }}
            />
          ) : (
            <div className="step-actions" onClick={(e) => e.stopPropagation()}>
              {running ? (
                <button className="btn" onClick={() => void api.cancelStep(step.id).then(onChanged)}>
                  取消
                </button>
              ) : (
                <>
                  <button className="btn ghost" disabled={busy || step.status === 'ok'} onClick={() => void submit({ markDone: true })}>
                    完成
                  </button>
                  <button className="btn ghost" disabled={step.status === 'skipped'} onClick={() => setNoteFor('skipped')}>
                    跳过
                  </button>
                  <button className="btn ghost" onClick={() => setNoteFor('failed')}>
                    失败…
                  </button>
                  <span className="spacer" />
                  {step.refMd === null && !refOpen && (
                    <button className="btn ghost" title="记下跑完应该看到什么，以后每次运行都能拿它比" onClick={() => setRefOpen(true)}>
                      ＋ 参考回显
                    </button>
                  )}
                  <button className="btn ghost" onClick={actions.addQa}>
                    ＋ 问答
                  </button>
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

// ── 粘贴：拆步 / 机器信息 ────────────────────────────────────

type PasteOffer = { kind: 'split'; commands: number; notes: number } | { kind: 'machine'; host: string } | { kind: 'mixed' }

/** 贴进来的内容值不值得问一句。 */
function pasteOfferFor(text: string, wholeBox: boolean): PasteOffer | null {
  const machine = machineLike(text)
  if (machine !== null && wholeBox) return { kind: 'machine', host: machine }
  const parts = pasteParts(text)
  if (parts.length < 2) return null
  const commands = parts.filter((p) => p.kind === 'command').length
  return { kind: 'split', commands, notes: parts.length - commands }
}

/** 一行 "IP 用户 密码"：只有一行、有 IP/主机、后面跟一两个词，不像命令。 */
function machineLike(text: string): string | null {
  const t = text.trim()
  if (t === '' || t.includes('\n')) return null
  const m = /^(?:\S+\s+)?((?:\d{1,3}\.){3}\d{1,3}|[\w-]+@[\w.-]+)(?::\d+)?\s+\S+(?:\s+\S+)?$/.exec(t)
  if (m === null) return null
  const first = t.split(/\s+/)[0]!
  if (/^(ssh|scp|ping|curl|telnet|nc)$/.test(first)) return null
  return m[1]!
}

/**
 * 贴进来的一段拆成若干块：按 shell 语法切命令（续行、多行引号、heredoc
 * 不会被切碎），命令前的注释当标题；夹在中间、明显不是命令的文字（像
 * "name可以改成自己的名字"）单独成文字块。
 */
function pasteParts(text: string): NewStepInput[] {
  const cmds = splitShellCommands(text)
  if (cmds.length === 0) return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: NewStepInput[] = []
  let cursor = 1
  const flushProse = (until: number): void => {
    const prose = lines
      .slice(cursor - 1, until - 1)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
      .join('\n')
      .trim()
    if (prose !== '' && !/^[`~]{3}/.test(prose)) out.push({ kind: 'note', title: noteTitle(prose), titleAuto: true, bodyMd: prose })
  }
  for (const c of cmds) {
    if (!looksLikeCommand(c.text)) continue
    flushProse(c.startLine)
    out.push({
      kind: 'command',
      title: c.comment ?? codeTitle('command', c.text),
      titleAuto: c.comment === null,
      command: c.text,
      lang: 'bash',
    })
    cursor = c.endLine + 1
  }
  flushProse(lines.length + 1)
  return out
}

/** 散文也会被 shell 切分器当成"一条命令"：只收第一个词像命令的。 */
function looksLikeCommand(text: string): boolean {
  const first = text.trim().split('\n')[0]!.trim()
  if (/[一-鿿]/.test(first.split(/\s+/)[0]!)) return false
  return /^[\w./~$({[-]/.test(first)
}

function PasteOfferBar({ offer, onSplit, onMachine, onDismiss }: { offer: PasteOffer; onSplit: () => void; onMachine: () => void; onDismiss: () => void }) {
  return (
    <div className="inline-offer" onClick={(e) => e.stopPropagation()}>
      {offer.kind === 'machine' ? (
        <>
          像是一台机器的登录信息（{offer.host}）——存成参数？密码会打码、只存本机
          <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={onMachine}>
            存成机器参数
          </button>
        </>
      ) : offer.kind === 'split' ? (
        <>
          贴进来 {offer.commands} 条命令{offer.notes > 0 ? `、${offer.notes} 段说明` : ''}，拆成 {offer.commands + offer.notes} 块？
          <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={onSplit}>
            拆开
          </button>
        </>
      ) : null}
      <button className="btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={onDismiss}>
        保持原样
      </button>
    </div>
  )
}

// ── 参考回显 / 回显历史 ──────────────────────────────────────

function ReferenceOutput({ step, open, onClose, onSave }: { step: Step; open: boolean; onClose: () => void; onSave: (refMd: string | null) => void }) {
  const [editing, setEditing] = useState(open && step.refMd === null)
  const [draft, setDraft] = useState(step.refMd ?? '')
  const [folded, setFolded] = useState(false)
  const html = useMemo(() => renderMarkdown(step.refMd ?? ''), [step.refMd])
  return (
    <div className="reference" onClick={(e) => e.stopPropagation()}>
      <div className="reference-head">
        <button className="fold" onClick={() => setFolded((v) => !v)}>
          {folded ? '▸' : '▾'}
        </button>
        <span className="label">参考回显</span>
        <span className="dim">跑完应该看到的样子（截图直接贴）</span>
        <span className="spacer" />
        {!editing && (
          <button className="btn ghost" onClick={() => setEditing(true)}>
            改
          </button>
        )}
      </div>
      {!folded &&
        (editing ? (
          <>
            <AutoTextarea
              autoFocus
              className="note-edit mono"
              minRows={3}
              value={draft}
              placeholder={'把正常情况下的回显贴在这里（```text 围起来更好看），或者贴截图'}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
                if (file !== undefined) {
                  e.preventDefault()
                  e.stopPropagation()
                  void uploadInline(file).then((url) => setDraft((d) => `${d}${d === '' ? '' : '\n\n'}![参考](${url})`))
                  return
                }
                // 直接贴一段纯文本回显：自动围起来
                const text = e.clipboardData.getData('text/plain')
                if (draft.trim() === '' && text.trim() !== '' && !text.includes('```')) {
                  e.preventDefault()
                  setDraft('```text\n' + text.replace(/\s+$/, '') + '\n```')
                }
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="cap-actions">
              <button
                className="btn primary"
                onClick={() => {
                  setEditing(false)
                  onSave(draft.trim() === '' ? null : draft.trim())
                  if (draft.trim() === '') onClose()
                }}
              >
                保存
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setEditing(false)
                  setDraft(step.refMd ?? '')
                  if (step.refMd === null) onClose()
                }}
              >
                取消
              </button>
            </div>
          </>
        ) : (
          <div className="md reference-body" dangerouslySetInnerHTML={{ __html: html }} />
        ))}
    </div>
  )
}

/** 回显当一等公民：历次输出、别的任务里同一步的，和参考回显逐行对比。 */
function OutputHistory({ step, evidenceCount, onChanged }: { step: Step; evidenceCount: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<StepOutputs | null>(null)
  const [a, setA] = useState<string>('ref')
  const [b, setB] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .stepOutputs(step.id)
      .then((d) => {
        setData(d)
        const latest = d.mine[0]?.id ?? d.others[0]?.id ?? ''
        setB(latest)
        setA(d.reference !== null ? 'ref' : (d.mine[1]?.id ?? d.others[0]?.id ?? ''))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, step.id, evidenceCount])

  if (!open) {
    return (
      <div className="history-toggle" onClick={(e) => e.stopPropagation()}>
        <button className="lesson-fold" onClick={() => setOpen(true)}>
          回显对比（这次 / 上次 / 参考 / 别的任务里的同一步）▸
        </button>
      </div>
    )
  }
  const options: Array<{ id: string; label: string; text: string }> = []
  if (data !== null) {
    if (data.reference !== null) options.push({ id: 'ref', label: '参考回显', text: stripFence(data.reference) })
    data.mine.forEach((m, i) => options.push({ id: m.id, label: `${i === 0 ? '这次' : `第 ${data.mine.length - i} 次`} · ${sourceLabel(m.source as Evidence['source'])} · ${new Date(m.createdAt).toLocaleString('zh-CN')}`, text: m.text ?? '' }))
    data.others.forEach((o) => options.push({ id: o.id, label: `「${o.taskTitle}」· ${new Date(o.createdAt).toLocaleDateString('zh-CN')}`, text: o.text ?? '' }))
  }
  const left = options.find((o) => o.id === a)
  const right = options.find((o) => o.id === b)
  const ops = left !== undefined && right !== undefined ? diffLines(left.text, right.text) : []
  const changed = ops.filter((o) => o.kind !== 'same').length

  return (
    <div className="history" onClick={(e) => e.stopPropagation()}>
      <div className="history-head">
        <span className="label">回显对比</span>
        <select value={a} onChange={(e) => setA(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="dim">→</span>
        <select value={b} onChange={(e) => setB(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="dim">{left !== undefined && right !== undefined ? (changed === 0 ? '完全一样' : `${changed} 行不一样`) : ''}</span>
        <span className="spacer" />
        {right !== undefined && b !== 'ref' && (
          <button
            className="btn ghost"
            title="以后每次运行都拿它比"
            onClick={() => {
              api
                .setReference(step.id, { evidenceId: b })
                .then(onChanged)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }}
          >
            设为参考回显
          </button>
        )}
        <button className="btn ghost" onClick={() => setOpen(false)}>
          收起
        </button>
      </div>
      {data === null ? (
        <div className="dim">读取中……</div>
      ) : options.length < 2 ? (
        <div className="dim">{options.length === 0 ? '还没有回显。跑一次或贴一段就有了。' : '只有一份回显，再跑一次（或设个参考回显）就能对比了。'}</div>
      ) : (
        <pre className="diff-view">
          {ops.map((o, i) => (
            <div key={i} className={`diff-${o.kind}`}>
              {o.kind === 'add' ? '+ ' : o.kind === 'del' ? '- ' : '  '}
              {o.text}
            </div>
          ))}
        </pre>
      )}
      {error !== null && <div className="verdict fail">{error}</div>}
    </div>
  )
}

/** 参考回显是 markdown（常常是一个 ```text 围栏）：对比时只取里面的文本。 */
function stripFence(md: string): string {
  const fences = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
  return fences.length > 0 ? fences.map((m) => m[1]!.replace(/\n$/, '')).join('\n') : md
}

// ── 问答（原"坑"）──────────────────────────────────────────

/**
 * 挂在这一步上的问答。平时：条件成立的一行预警，其余折叠；失败时全部展开
 * （宪法 14：坑在该出现的时候出现）。问和答可以只有一个。
 */
function QaInline({ items, step, failed, onChanged, actions }: { items: QaItem[]; step: Step; failed: boolean; onChanged: () => void; actions: Pick<StepActions, 'ask'> }) {
  const [fold, setFold] = useState(false)
  if (items.length === 0) return null
  const first = items.filter((q) => q.matched === true && !q.stale)
  const rest = items.filter((q) => !(q.matched === true && !q.stale))
  return (
    <div className="lesson-list" onClick={(e) => e.stopPropagation()}>
      {first.map((q) => (
        <QaRow key={q.id} item={q} step={step} open={failed} onChanged={onChanged} actions={actions} />
      ))}
      {rest.length > 0 &&
        (failed || fold ? (
          rest.map((q) => <QaRow key={q.id} item={q} step={step} open={failed} dim onChanged={onChanged} actions={actions} />)
        ) : (
          <button className="lesson-fold" onClick={() => setFold(true)}>
            另有 {rest.length} 条问答（条件不符 / 疑似过期）▸
          </button>
        ))}
    </div>
  )
}

export function QaRow({
  item,
  step,
  open: forceOpen,
  dim = false,
  onChanged,
  actions,
}: {
  item: QaItem
  step: Step | null
  open: boolean
  dim?: boolean
  onChanged: () => void
  /** 只用到 ask（问发起人）。 */
  actions?: Pick<StepActions, 'ask'>
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = forceOpen || open
  const headline = item.question !== '' ? item.question.split('\n')[0] : item.answer.split('\n')[0]

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <QaForm
        initial={{ question: item.question, answer: item.answer, condition: item.condition ?? '' }}
        submitLabel="保存"
        onCancel={() => setEditing(false)}
        onSubmit={async (v) => {
          await api.updateQa(item.id, { question: v.question, answer: v.answer, condition: v.condition === '' ? null : v.condition })
          setEditing(false)
          onChanged()
        }}
      />
    )
  }

  return (
    <div className={`lesson-row qa${dim ? ' dim' : ''}`}>
      <button className="lesson-warn" title={item.condition !== null ? `条件：${item.condition}` : undefined} onClick={() => setOpen((v) => !v)}>
        {item.question !== '' ? '？' : '⚠'} {headline}
        {item.question !== '' && item.answer === '' && <span className="qa-open">{item.askedAt !== null ? ' · 问过发起人，等回答' : ' · 还没有答案'}</span>}
        <span className="lesson-tail">{qaTail(item)}</span>
        {shown ? ' ▴' : ' ▸'}
      </button>
      {shown && (
        <div className="lesson-detail">
          {item.question !== '' && item.answer !== '' && <div className="qa-answer md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.answer) }} />}
          {item.question === '' && item.answer.includes('\n') && <div className="qa-answer md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.answer) }} />}
          {item.condition !== null && (
            <div className="line">
              条件：{item.condition}
              {item.matched === false ? '（当前不匹配）' : item.matched === null ? '（判定不了）' : ''}
            </div>
          )}
          <div className="lesson-actions">
            {item.fixCommand !== null && step !== null && (
              <button
                className="btn primary"
                disabled={busy}
                title={item.status === 'unverified' ? '来源未验证：只插入修复步骤，你确认后再运行' : '插入修复步骤并运行（跑通自动记"帮上一次"）'}
                onClick={() =>
                  void act(async () => {
                    // 未验证的只插入不自动运行——同事的内容上本机执行，要过人手一道
                    const s = await api.applyLessonFix(item.id, step.id)
                    if (item.status !== 'unverified') await api.runStep(s.id)
                  })
                }
              >
                按这个修{item.status === 'unverified' ? '（未验证 · 插入不运行）' : ''}
              </button>
            )}
            {item.question !== '' && item.answer === '' && item.askedAt === null && actions !== undefined && (
              <button className="btn" disabled={busy} onClick={actions.ask}>
                问发起人
              </button>
            )}
            {item.mine && (
              <button className="btn ghost" disabled={busy} onClick={() => setEditing(true)}>
                {item.answer === '' ? '写答案' : '改'}
              </button>
            )}
            {!item.mine && step !== null && (
              <button className="btn ghost" disabled={busy} onClick={() => void act(() => api.lessonMiss(item.id))}>
                不是这个
              </button>
            )}
            {item.mine && item.status === 'personal' && (
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('删掉这条问答？')) void act(() => api.deleteQa(item.id))
                }}
              >
                删
              </button>
            )}
          </div>
          {error !== null && <div className="verdict fail">{error}</div>}
        </div>
      )}
    </div>
  )
}

function qaTail(q: QaItem): string {
  const bits = [q.mine ? '我记的' : q.author, q.status === 'confirmed' ? '已确认' : q.status === 'unverified' ? '未验证' : '', q.stale ? '疑似过期' : '', q.hits > 0 ? `帮过 ${q.hits} 次` : '']
  return bits.filter(Boolean).join(' · ')
}

/** 问答表单：问和答至少一个，条件可选。 */
export function QaForm({
  initial,
  submitLabel = '记下',
  withScope = false,
  onSubmit,
  onCancel,
}: {
  initial?: { question: string; answer: string; condition: string }
  submitLabel?: string
  withScope?: boolean
  onSubmit: (v: { question: string; answer: string; condition: string; scope: 'personal' | 'team' }) => Promise<void>
  onCancel: () => void
}) {
  const [question, setQuestion] = useState(initial?.question ?? '')
  const [answer, setAnswer] = useState(initial?.answer ?? '')
  const [condition, setCondition] = useState(initial?.condition ?? '')
  const [showCond, setShowCond] = useState((initial?.condition ?? '') !== '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (scope: 'personal' | 'team'): Promise<void> => {
    if (question.trim() === '' && answer.trim() === '') {
      setError('问和答至少写一个')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ question: question.trim(), answer: answer.trim(), condition: condition.trim(), scope })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lesson-form" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="field">
        <span className="label">问（可以只写问，答案以后补或者问发起人）</span>
        <AutoTextarea className="inline-edit" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="比如：权重一般放在哪？报 No route to host 怎么办？" />
      </div>
      <div className="field">
        <span className="label">答（可以只写答，记一条经验）</span>
        <AutoTextarea className="inline-edit" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="怎么做的 / 为什么（命令用 ``` 围起来，[按这个修] 能直接用）" />
      </div>
      {showCond ? (
        <div className="field">
          <span className="label">什么时候适用（可选）</span>
          <input className="inline-edit" value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="如 容器名 == vllm_test 或 环境.GPU 包含 910B" />
        </div>
      ) : (
        <button className="lesson-fold" onClick={() => setShowCond(true)}>
          ＋ 只在某些情况下适用？
        </button>
      )}
      {error !== null && <div className="verdict fail">{error}</div>}
      <div className="cap-actions">
        {withScope ? (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void save('team')}>
              {submitLabel}并共享
            </button>
            <button className="btn" disabled={busy} onClick={() => void save('personal')}>
              只记给自己
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => void save('personal')}>
            {submitLabel}
          </button>
        )}
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

/** 捕获提议卡片：失败后修好（预填问/答/条件）或偏离底稿（带回）。 */
function CaptureCard({ offer, onChanged }: { offer: LessonOfferView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = async (input: Record<string, unknown> = {}): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.acceptLessonOffer(offer.id, input)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (offer.kind === 'deviation') {
    return (
      <div className="capture-card" onClick={(e) => e.stopPropagation()}>
        <div className="cap-title">这步改得和底稿不一样了——要把这个改动带回底稿吗？</div>
        <pre className="cap-diff">
          <span className="del">- {String(offer.payload.before ?? '')}</span>
          {'\n'}
          <span className="add">+ {String(offer.payload.after ?? '')}</span>
        </pre>
        {error !== null && <div className="verdict fail">{error}</div>}
        <div className="cap-actions">
          <button className="btn primary" disabled={busy} onClick={() => void accept()}>
            带回底稿
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void api.dismissLessonOffer(offer.id).then(onChanged)}>
            不用
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="capture-card" onClick={(e) => e.stopPropagation()}>
      <div className="cap-title">刚才是失败后改了命令才跑通的——记一条问答？</div>
      <QaForm
        initial={{ question: String(offer.payload.symptom ?? ''), answer: '```\n' + String(offer.payload.after ?? '') + '\n```', condition: typeof offer.payload.condition === 'string' ? offer.payload.condition : '' }}
        withScope
        onCancel={() => void api.dismissLessonOffer(offer.id).then(onChanged)}
        onSubmit={async (v) => {
          await accept({ symptom: v.question, fixMd: v.answer, condition: v.condition === '' ? null : v.condition, scope: v.scope })
        }}
      />
      {error !== null && <div className="verdict fail">{error}</div>}
    </div>
  )
}

// ── 跳过 / 失败 / 菜单 ───────────────────────────────────────

/** 跳过 / 标记失败时的一句原因。可以留空——不追问理由。 */
function NoteForm({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: 'skipped' | 'failed'
  onSubmit: (note: string) => void
  onCancel: () => void
}) {
  const [note, setNote] = useState('')
  return (
    <div className="note-form" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        className="inline-edit editing"
        placeholder={kind === 'skipped' ? '为什么跳过（可选），回车确认' : '怎么失败的（可选），回车确认'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onSubmit(note)
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button className={`btn ${kind === 'failed' ? 'danger' : 'primary'}`} onClick={() => onSubmit(note)}>
        {kind === 'skipped' ? '跳过' : '标记失败'}
      </button>
      <button className="btn ghost" onClick={onCancel}>
        取消
      </button>
    </div>
  )
}

/** ⋯ 菜单：不常用但要找得到的操作，都附上快捷键。 */
function MoreMenu({
  step,
  canMove,
  actions,
  delegated = false,
  teamUsers = [],
  teamEnabled = false,
}: {
  step: Step
  canMove: Record<MoveDirection, boolean>
  actions: StepActions
  delegated?: boolean
  teamUsers?: TeamUser[]
  teamEnabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const item = (label: string, keys: string, fn: () => void, enabled = true) => (
    <button
      className="menu-item"
      disabled={!enabled}
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      <span>{label}</span>
      <kbd>{keys}</kbd>
    </button>
  )

  const section = isSection(step)
  const content = isContent(step)
  const parts = step.command !== null && (step.kind === 'command' || step.kind === 'check') ? pasteParts(step.command) : []

  return (
    <span className="more" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="btn ghost more-btn" title="更多操作" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div className="menu">
          {item('在下面插一步命令', '/', () => actions.insertAfter('command'))}
          <div className="menu-group">
            <span className="menu-label">在下面插</span>
            {(['section', 'note', 'code', 'output', 'manual'] as const).map((k) => (
              <button
                key={k}
                className="chip"
                onClick={() => {
                  setOpen(false)
                  actions.insertAfter(k)
                }}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {parts.length >= 2 && item(`拆成 ${parts.length} 块`, '', () => actions.split(parts))}
          {item('上移', 'Alt+↑', () => actions.move('up'), canMove.up)}
          {item('下移', 'Alt+↓', () => actions.move('down'), canMove.down)}
          {item(section ? '缩进（挂到上一章下面）' : '缩进（挂到上一项下面）', 'Tab', () => actions.move('indent'), canMove.indent)}
          {item('往外提一层', 'Shift+Tab', () => actions.move('outdent'), canMove.outdent)}
          {item('记一条问答', '', actions.addQa)}
          {!content &&
            step.kind !== 'delegate' &&
            item(step.shareOutput ? '✓ 输出共享给发起人（点击取消）' : '把输出共享给发起人', '', () => void actions.edit({ shareOutput: !step.shareOutput }))}
          {!content && step.kind !== 'delegate' && !delegated && (
            <DelegateItem
              users={teamUsers}
              enabled={teamEnabled}
              onDelegate={(input) => {
                setOpen(false)
                void actions.delegate(input)
              }}
            />
          )}
          {!section && step.kind !== 'delegate' && (
            <div className="menu-group">
              <span className="menu-label">改成</span>
              {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>)
                .filter((k) => k !== 'section')
                .map((k) => (
                  <button
                    key={k}
                    className={`chip${step.kind === k ? ' on' : ''}`}
                    onClick={() => {
                      setOpen(false)
                      void actions.edit(kindPatch(step, k))
                    }}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
            </div>
          )}
          {!content &&
            step.status !== 'pending' &&
            step.status !== 'running' &&
            item('重置为未开始', '', () => actions.setStatus('pending'))}
          {item(section ? '删除这一章（连同里面的）' : '删除', 'Delete', actions.remove)}
        </div>
      )}
    </span>
  )
}

/** 换类型时顺手搬内容：文字 ↔ 命令/代码的正文放的位置不一样。 */
function kindPatch(step: Step, kind: StepKind): StepPatchInput {
  if (kind === 'note' && step.kind !== 'note') {
    const body = step.command !== null ? '```' + (step.lang ?? '') + '\n' + step.command + '\n```' : step.titleAuto ? '' : step.title
    return { kind, bodyMd: body === '' ? null : body, command: null, titleAuto: true }
  }
  if (step.kind === 'note' && kind !== 'note') {
    const fence = /```([^\n]*)\n([\s\S]*?)```/.exec(step.bodyMd ?? '')
    return { kind, command: fence !== null ? fence[2]!.replace(/\n$/, '') : (step.bodyMd ?? null), lang: fence?.[1]?.trim() || (kind === 'output' ? null : 'bash'), bodyMd: null, titleAuto: true }
  }
  return { kind }
}

/** 委派项：从团队成员里选人，可以交代一句。 */
function DelegateItem({
  users,
  enabled,
  onDelegate,
}: {
  users: TeamUser[]
  enabled: boolean
  onDelegate: (input: { assigneeName: string; displayName?: string; note?: string }) => void
}) {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  if (!enabled) {
    return (
      <div className="delegate-item dim" style={{ padding: '4px 8px' }}>
        委派给别人需要团队服务（设置 · 团队）
      </div>
    )
  }
  const chosen = users.find((u) => u.name === name)
  const submit = (): void => {
    if (chosen === undefined) return
    onDelegate({ assigneeName: chosen.name, displayName: chosen.displayName, ...(note.trim() !== '' ? { note: note.trim() } : {}) })
  }
  return (
    <div className="delegate-item" style={{ padding: '4px 8px' }} onKeyDown={(e) => e.stopPropagation()}>
      <span className="dim" style={{ fontSize: 12 }}>
        委派给
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
        <select value={name} onChange={(e) => setName(e.target.value)} style={{ fontSize: 12 }}>
          <option value="">选一个人…</option>
          {users.map((u) => (
            <option key={u.name} value={u.name}>
              {u.displayName}（手上 {u.taskCount} 个任务）
            </option>
          ))}
        </select>
        <input
          className="inline-edit"
          placeholder="交代一句（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          style={{ fontSize: 12 }}
        />
        <button className="btn primary" disabled={chosen === undefined} onClick={submit}>
          委派给{chosen?.displayName ?? '…'}
        </button>
      </div>
    </div>
  )
}

/** 委派行：交给了谁、对方做到第几步、有没有卡住；可以打开对方的 runbook、留言。 */
function DelegationRow({ step, delegation, displayName }: { step: Step; delegation: Delegation | undefined; displayName: string }) {
  const [mirror, setMirror] = useState<{ data: DelegationMirror | null; note?: string } | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (delegation === undefined) {
    return <div className="cmd-note">这一步是委派类型，但没有委派记录（旧数据）——可以改回普通步骤再重新委派。</div>
  }
  const statusText =
    step.status === 'ok'
      ? '已完成'
      : step.status === 'failed'
        ? '没做成'
        : delegation.status === 'blocked'
          ? '卡住了'
          : delegation.status === 'draft'
            ? '还没开始'
            : '进行中'
  const open = (): void => {
    setError(null)
    api
      .delegationMirror(step.id)
      .then((r) => setMirror({ data: r.mirror, ...(r.note !== undefined ? { note: r.note } : {}) }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const send = (): void => {
    if (comment.trim() === '') return
    setBusy(true)
    setError(null)
    api
      .delegationComment(step.id, comment.trim())
      .then(() => setComment(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="delegation-row" onClick={(e) => e.stopPropagation()}>
      <div>
        <span className={`gem ${delegation.worstAlert === 'red' ? 'stuck' : delegation.worstAlert === 'yellow' ? 'wobble' : 'ok'}`}>
          {delegation.worstAlert === 'red' ? '○' : delegation.worstAlert === 'yellow' ? '◐' : '●'}
        </span>{' '}
        {displayName} · {statusText}
        {delegation.total > 0 && ` · ${delegation.done}/${delegation.total} 步`}
        {delegation.worstAlert === 'red' && <span className="verdict fail"> · 对方卡住了，需要你看一眼</span>}
        <span className="dim"> · 更新于 {new Date(delegation.updatedAt).toLocaleTimeString('zh-CN')}</span>
      </div>
      <div className="step-actions">
        <button className="btn" onClick={open}>
          打开对方 runbook
        </button>
        <input
          className="inline-edit"
          placeholder="给对方留言（会出现在对方的时间线里）"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') send()
          }}
          style={{ flex: 1, fontSize: 12.5 }}
        />
        <button className="btn ghost" disabled={busy || comment.trim() === ''} onClick={send}>
          留言
        </button>
      </div>
      {error !== null && <div className="verdict fail">{error}</div>}
      {mirror !== null && (
        <div className="mirror">
          {mirror.data === null ? (
            <div className="dim">{mirror.note ?? '对方还没同步上来'}</div>
          ) : (
            <>
              <div className="dim">
                {mirror.data.task.assigneeName} 的 runbook（只读）{' '}
                <button className="btn ghost" onClick={() => setMirror(null)}>
                  收起
                </button>
              </div>
              {mirror.data.steps.length === 0 && <div className="dim">对方还没写 runbook。</div>}
              {mirror.data.steps.map((s) => (
                <div key={s.id} className={`mirror-step${s.parentId !== null ? ' depth-1' : ''}`}>
                  <span className="step-mark">{s.kind === 'section' ? '§' : mark({ status: s.status } as Step, false)}</span> {s.title}
                  {s.statusNote !== null && <span className="dim"> —— {s.statusNote}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 这一步上的评论（发起人/同事在远程界面针对这一步说的话）。 */
function StepComments({ comments }: { comments: Event[] | undefined }) {
  if (comments === undefined || comments.length === 0) return null
  return (
    <div className="step-comments">
      {comments.map((c) => (
        <div key={c.id} className="remote-comment">
          <strong>{typeof c.payload.author === 'string' && c.payload.author !== '' ? c.payload.author : '发起人'}</strong>：
          {typeof c.payload.body === 'string' ? c.payload.body : ''}
          <span className="dim"> · {new Date(c.createdAt).toLocaleTimeString('zh-CN')}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 失败诊断面板。
 *
 * QB 先查团队记过的问答，再给可执行的路径。产品宪法第 9 条"流程不能停"：
 * 失败不是终点，而是"接下来可以做这几件事"。
 */
function DiagnosePanel({ stepId, onApplied }: { stepId: string; onApplied: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<Diagnosis | null>(null)
  const [message, setMessage] = useState('')

  if (state === 'idle') {
    return (
      <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
        <button
          className="btn"
          onClick={() => {
            setState('busy')
            api
              .diagnose(stepId)
              .then((d) => {
                setResult(d)
                setState('done')
              })
              .catch((e: unknown) => {
                setMessage(e instanceof Error ? e.message : String(e))
                setState('error')
              })
          }}
        >
          让 QB 看看
        </button>
      </div>
    )
  }

  if (state === 'busy') {
    return (
      <div className="paste-hint" style={{ marginTop: 8 }}>
        QB 正在查团队记过的问答……
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="verdict fail" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
        {message}{' '}
        <button className="btn ghost" onClick={() => setState('idle')}>
          重试
        </button>
      </div>
    )
  }

  const d = result!
  return (
    <div className="lesson-chip" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontWeight: 500 }}>{d.summary}</div>

      {d.fromLessonId !== null && (
        <div className="origin" style={{ marginTop: 3 }}>
          依据团队记录的问答
        </div>
      )}

      {d.options.map((o, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 500 }}>
            {i + 1}. {o.label}
          </div>
          <div style={{ color: 'var(--text-dim)' }}>{o.detail}</div>
          {o.command !== undefined && (
            <div className="cmd" style={{ marginTop: 4 }}>
              <CodeView html={highlightHtml(o.command, 'bash')} />
              <div className="actions">
                <button className="btn" onClick={() => void navigator.clipboard.writeText(o.command!)}>
                  ⧉
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {d.askInstead !== null && <div style={{ marginTop: 8, color: 'var(--warn)' }}>建议问人：{d.askInstead}</div>}

      <div style={{ marginTop: 8, display: 'flex', gap: 5 }}>
        <button className="btn ghost" onClick={() => setState('idle')}>
          收起
        </button>
        <button className="btn ghost" onClick={onApplied}>
          刷新状态
        </button>
      </div>
    </div>
  )
}

// ── 展示与编辑辅助 ────────────────────────────────────────────

/** 改预计耗时时，超时跟着按 3 倍重算（与起草时的规则一致，下限 30 秒）。 */
function minutesPatch(minutes: number): StepPatchInput {
  return { expectedMinutes: minutes, timeoutMs: Math.max(30_000, Math.round(minutes * 60_000 * 3)) }
}

function originBadge(step: Step, lastEdit: Event | undefined): { label: string; title: string; cls: string } | null {
  if (step.editedBy !== null) {
    return { label: '我改的', title: lastEdit !== undefined ? describeEdit(lastEdit) : '', cls: 'mine' }
  }
  switch (step.origin) {
    case 'qb':
      return { label: 'QB 写的', title: 'QB 起草的内容，请逐条核对', cls: 'qb' }
    case 'import':
      return { label: '原文', title: '命令逐字来自你贴进来的材料', cls: 'source' }
    case 'base':
      return { label: '底稿', title: '从别的任务复制来的', cls: 'source' }
    default:
      return null
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
  timeoutMs: '超时',
  kind: '类型',
  probe: '就绪条件',
}

function describeEdit(e: Event): string {
  const changes = Array.isArray(e.payload.changes) ? (e.payload.changes as Array<{ field: string; before: unknown; after: unknown }>) : []
  const when = new Date(e.createdAt).toLocaleString('zh-CN')
  return (
    `${when} 改过：\n` +
    changes
      .filter((c) => c.field !== 'timeoutMs' && c.field !== 'titleAuto')
      .map((c) => `${FIELD_LABEL[c.field] ?? c.field}：${short(c.before)} → ${short(c.after)}`)
      .join('\n')
  )
}

function short(v: unknown): string {
  if (v === null || v === undefined) return '（空）'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

function expectationText(e: Expectation): string {
  switch (e.kind) {
    case 'contains':
    case 'notContains':
      return e.text
    case 'manual':
      return e.description
    case 'regex':
      return e.pattern
    case 'exitCode':
      return String(e.code)
  }
}

/** 按原来的预期类型套用新文字；原来没有预期时按步骤类型选一种。 */
function withExpectationText(e: Expectation | null, text: string, kind: StepKind): Expectation | null {
  if (text === '') return null
  if (e === null) {
    return kind === 'manual' || kind === 'decision'
      ? { kind: 'manual', description: text }
      : { kind: 'contains', text, caseSensitive: true }
  }
  switch (e.kind) {
    case 'contains':
    case 'notContains':
      return { ...e, text }
    case 'manual':
      return { ...e, description: text }
    case 'regex':
      return { ...e, pattern: text }
    case 'exitCode':
      return /^-?\d+$/.test(text) ? { kind: 'exitCode', code: Number(text) } : { kind: 'contains', text, caseSensitive: true }
  }
}

function mark(step: Step, running: boolean): string {
  if (running) return '▶'
  switch (step.status) {
    case 'ok':
      return '✓'
    case 'failed':
      return '✗'
    case 'skipped':
      return '⤼'
    case 'blocked':
      return '⏸'
    case 'running':
      return '▶'
    default:
      return '○'
  }
}

function markClass(step: Step, running: boolean): string {
  if (running) return 'running'
  return step.status === 'ok' ? 'ok' : step.status === 'failed' ? 'failed' : ''
}

function hintTail(step: Step, runState: StepRunState | undefined): string {
  if (runState?.durationMs !== undefined && runState.partial !== true) return ` · ${formatMs(runState.durationMs)}`
  if (step.actualMs !== null) return ` · ${formatMs(step.actualMs)}`
  return ''
}

function sourceLabel(s: Evidence['source']): string {
  return s === 'auto' ? '运行' : s === 'paste' ? '手动粘贴' : '截图'
}

function verdictLabel(v: 'pass' | 'fail' | 'unclear'): string {
  return v === 'pass' ? '✓ 符合预期' : v === 'fail' ? '✗ 不符合预期' : '? 需要判断'
}

function describeExpectation(e: NonNullable<Step['expectation']>): string {
  switch (e.kind) {
    case 'exitCode':
      return `退出码 ${e.code}`
    case 'contains':
      return `输出包含 "${e.text}"`
    case 'notContains':
      return `输出不含 "${e.text}"`
    case 'regex':
      return `输出匹配 /${e.pattern}/`
    case 'manual':
      return e.description
  }
}

function describeProbe(p: NonNullable<Step['probe']>): string {
  switch (p.kind) {
    case 'http':
      return `${p.url} 返回 ${p.expectStatus}`
    case 'port':
      return `${p.host}:${p.port} 开始监听`
    case 'logPattern':
      return `日志出现 /${p.pattern}/`
    case 'command':
      return `\`${p.command}\` 退出码 ${p.expectExitCode}`
  }
}

function formatMinutes(min: number): string {
  if (!Number.isFinite(min)) return ''
  if (min < 1) return `${Math.round(min * 60)} 秒`
  if (min < 60) return `${min % 1 === 0 ? min : min.toFixed(1)} 分钟`
  return `${(min / 60).toFixed(1)} 小时`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

export { pasteParts }
