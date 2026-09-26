import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Event, Evidence, Expectation, Param, Step, StepKind } from '@qb/core'
import { isSection, PARAM_RE, renderCommand, type MoveDirection } from '@qb/core'
import { ApiError, api, evidenceImageUrl, type Diagnosis, type FidelityView, type Job, type StepPatchInput } from './api.ts'
import { Editable } from './Editable.tsx'

export interface StepRunState {
  output: string
  running: boolean
  verdict?: 'pass' | 'fail' | 'unclear'
  reason?: string
  durationMs?: number
  redactionHits?: string[]
}

/** 单元对 runbook 的操作都交给上层：它负责撤销记录与刷新。 */
export interface StepActions {
  edit(patch: StepPatchInput): Promise<void>
  insertAfter(): void
  remove(): void
  move(dir: MoveDirection): void
  setStatus(status: 'pending' | 'ok' | 'failed' | 'skipped', note?: string): void
  /** 把多行命令拆成多步：第一行留在这一步，其余各成一步。 */
  split(lines: string[]): void
  uploadImage(file: File): void
}

interface Props {
  step: Step
  current: boolean
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
  /** 刚插入的新步骤：直接进入标题编辑。 */
  autoEdit: boolean
  canMove: Record<MoveDirection, boolean>
  actions: StepActions
  onFocus: () => void
  onChanged: () => void
}

const KIND_LABEL: Record<Exclude<StepKind, 'delegate' | 'note'>, string> = {
  command: '命令',
  check: '检查',
  wait: '等待就绪',
  manual: '人工',
  decision: '需要拍板',
}

/**
 * 一个步骤单元。
 *
 * 产品宪法在这里的落点：
 * - 一切细节在原地可见（为什么/命令/预期/输出），不藏在弹窗
 * - 点即编辑，没有"编辑模式"；人写的内容和 QB 写的一眼可辨（宪法 12）
 * - 不当保姆：运行、复制、手动跑后粘贴、贴截图、直接标记完成，随用户喜好
 * - 破坏性命令红框 + 内联确认开关，不弹窗
 */
export function StepCell(props: Props) {
  const { step } = props
  if (isSection(step)) return <SectionHead {...props} />
  return <StepBody {...props} />
}

function SectionHead({ step, current, autoEdit, canMove, actions, onFocus }: Props) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className={`section-head${current ? ' current' : ''}`} onClick={onFocus}>
      <Editable
        value={step.title}
        autoEdit={autoEdit}
        onSave={(title) =>
          actions
            .edit({ title })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        }
      />
      {error !== null && <span className="verdict fail">{error}</span>}
      <span className="spacer" />
      <MoreMenu step={step} canMove={canMove} actions={actions} />
    </div>
  )
}

function StepBody({ step, current, runState, evidence, params, fidelity, job, lastEdit, autoEdit, canMove, actions, onFocus, onChanged }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [danger, setDanger] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [noteFor, setNoteFor] = useState<'skipped' | 'failed' | null>(null)
  const [splitOffer, setSplitOffer] = useState<string[] | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // 命令改了，之前那条命令的破坏性确认就不作数了
  useEffect(() => {
    setDanger(null)
    setConfirmed(false)
  }, [step.command])

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

  const run = async (): Promise<void> => {
    setError(null)
    try {
      await api.runStep(step.id, confirmed ? { confirmed: true } : {})
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

  /** 空命令里粘进多行：问一句要不要拆成多步。 */
  const offerSplit = (text: string): boolean => {
    const lines = splitCommands(text)
    if (lines.length < 2) return false
    setSplitOffer(lines)
    return true
  }

  const isDangerous = danger !== null
  const rendered = step.command !== null ? renderCommand(step.command, params) : { text: '', missing: [] as string[], undeclared: [] as string[] }
  const badge = originBadge(step, lastEdit)

  return (
    <div
      className={`step${current ? ' current' : ''}${dragOver ? ' drag-image' : ''}`}
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
        <span className="step-title">
          <Editable value={step.title} autoEdit={autoEdit} onSave={(title) => edit({ title })} />
        </span>
        {badge !== null && (
          <span className={`origin-badge ${badge.cls}`} title={badge.title}>
            {badge.label}
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
        <MoreMenu step={step} canMove={canMove} actions={actions} />
      </div>

      <div className="step-why">
        <Editable
          value={step.whyMd ?? ''}
          multiline
          placeholder="为什么要做这一步（一句话）"
          showPlaceholder={current}
          onSave={(v) => edit({ whyMd: v === '' ? null : v })}
        />
        {step.whySource !== null && <span className="source"> — {step.whySource}</span>}
      </div>

      <div className="step-body">
        {step.command !== null || current ? (
          <>
            <div className={`cmd${isDangerous ? ' destructive' : ''}${step.command === null ? ' placeholder' : ''}`}>
              <pre>
                <Editable
                  value={step.command ?? ''}
                  multiline
                  mono
                  placeholder="＋ 命令"
                  display={(template) => renderWithParams(template, params)}
                  onPasteIntoEmpty={offerSplit}
                  onSave={(v) => edit({ command: v === '' ? null : v })}
                />
              </pre>
              {step.command !== null && (
                <div className="actions">
                  <button
                    className="btn primary"
                    title={rendered.missing.length > 0 ? `缺参数：${rendered.missing.join('、')}` : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      void run()
                    }}
                    disabled={running || (isDangerous && !confirmed) || rendered.missing.length > 0}
                  >
                    {running ? '运行中' : '▶ 运行'}
                  </button>
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void navigator.clipboard.writeText(rendered.text)
                    }}
                  >
                    ⧉ 复制
                  </button>
                </div>
              )}
            </div>

            {step.command !== null && rendered.missing.length > 0 && (
              <div className="cmd-note">缺参数：{rendered.missing.join('、')} —— 在上面的参数面板里补上</div>
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
            {step.command !== null && fidelity?.unverified === true && (
              <div className="cmd-note">参数缺值，没法跟素材原文核对</div>
            )}

            {splitOffer !== null && (
              <div className="inline-offer" onClick={(e) => e.stopPropagation()}>
                粘进来 {splitOffer.length} 行命令，拆成 {splitOffer.length} 步？
                <button
                  className="btn primary"
                  onClick={() => {
                    actions.split(splitOffer)
                    setSplitOffer(null)
                  }}
                >
                  拆成 {splitOffer.length} 步
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    edit({ command: splitOffer.join('\n') })
                    setSplitOffer(null)
                  }}
                >
                  保持一步
                </button>
              </div>
            )}

            {isDangerous && (
              <div className="danger-note">
                <span>⚠ {danger.join('、')}</span>
                <label onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  我确认要运行
                </label>
              </div>
            )}
          </>
        ) : null}

        {step.probe !== null && (
          <div className="expectation">
            <span className="label">就绪条件：</span>
            {describeProbe(step.probe)}
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
              <div className={`verdict ${runState.verdict}`}>
                {verdictLabel(runState.verdict)} · {runState.reason}
                {runState.durationMs !== undefined && ` · ${formatMs(runState.durationMs)}`}
              </div>
            )}
            {(runState?.redactionHits?.length ?? 0) > 0 && (
              <div className="paste-hint">已脱敏：{runState!.redactionHits!.join('、')}</div>
            )}
            {lastText?.redacted === true && liveOutput === null && <div className="paste-hint">已脱敏</div>}
          </div>
        )}

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
        {!running && (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              className="inline-edit"
              placeholder={
                step.command !== null
                  ? '自己跑的话，把输出粘贴到这里（截图直接 Ctrl+V 或拖进来）'
                  : '做完了？可以写点什么，或贴一张截图（可选）'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={draft === '' ? 1 : 4}
              style={{ marginTop: 7, fontSize: 12.5, fontFamily: 'var(--mono)' }}
            />
            {draft !== '' && (
              <button className="btn primary" style={{ marginTop: 5 }} disabled={busy} onClick={() => void submit({ text: draft })}>
                提交输出
              </button>
            )}
          </div>
        )}

        {step.statusNote !== null && (step.status === 'skipped' || step.status === 'failed') && (
          <div className={`verdict ${step.status === 'failed' ? 'fail' : 'unclear'}`}>
            {step.status === 'skipped' ? '已跳过' : '标记失败'}：{step.statusNote}
          </div>
        )}

        {error !== null && <div className="verdict fail">{error}</div>}

        {/* 失败了就让 QB 看看——这是"流程不能停"的落点 */}
        {(step.status === 'failed' || runState?.verdict === 'fail') && (
          <DiagnosePanel stepId={step.id} onApplied={onChanged} />
        )}

        {noteFor !== null ? (
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

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
function MoreMenu({ step, canMove, actions }: { step: Step; canMove: Record<MoveDirection, boolean>; actions: StepActions }) {
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

  const lines = splitCommands(step.command ?? '')
  const section = isSection(step)

  return (
    <span className="more" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="btn ghost more-btn" title="更多操作" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div className="menu">
          {item('在下面插入一步', '/', actions.insertAfter)}
          {!section && lines.length >= 2 && item(`拆成 ${lines.length} 步`, '', () => actions.split(lines))}
          {item('上移', 'Alt+↑', () => actions.move('up'), canMove.up)}
          {item('下移', 'Alt+↓', () => actions.move('down'), canMove.down)}
          {!section && item('移进上一章', 'Tab', () => actions.move('indent'), canMove.indent)}
          {!section && item('移出章节', 'Shift+Tab', () => actions.move('outdent'), canMove.outdent)}
          {!section && (
            <div className="menu-group">
              <span className="menu-label">类型</span>
              {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((k) => (
                <button
                  key={k}
                  className={`chip${step.kind === k ? ' on' : ''}`}
                  onClick={() => {
                    setOpen(false)
                    void actions.edit({ kind: k })
                  }}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          {!section &&
            step.status !== 'pending' &&
            step.status !== 'running' &&
            item('重置为未开始', '', () => actions.setStatus('pending'))}
          {item(section ? '删除这一章（连同步骤）' : '删除', 'Delete', actions.remove)}
        </div>
      )}
    </span>
  )
}

/**
 * 失败诊断面板。
 *
 * QB 先查团队踩过的坑，再给可执行的路径。产品宪法第 9 条"流程不能停"：
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
        QB 正在查团队踩过的坑……
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
          依据团队记录的坑
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
              <pre>{o.command}</pre>
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

/** 多行命令按行拆开；空行与纯注释行不算一步。 */
export function splitCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

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
      return { label: '底稿', title: '从底稿复制来的', cls: 'source' }
    default:
      return null
  }
}

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  whyMd: '为什么',
  command: '命令',
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
      .filter((c) => c.field !== 'timeoutMs')
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

/** 模板 → 渲染值展示：参数带下划线（悬停显示名字），缺值标红。 */
function renderWithParams(template: string, params: Param[]): ReactNode {
  const byName = new Map(params.map((p) => [p.name, p]))
  const out: ReactNode[] = []
  let last = 0
  let key = 0

  for (const m of template.matchAll(PARAM_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(template.slice(last, idx))
    const p = byName.get(m[1]!)
    out.push(
      p !== undefined && p.value !== '' ? (
        <span key={key++} className="param-slot" title={m[1]}>
          {p.value}
        </span>
      ) : (
        <span key={key++} className="param-slot missing" title={`${m[1]}（缺值）`}>
          {m[0]}
        </span>
      ),
    )
    last = idx + m[0].length
  }
  if (last < template.length) out.push(template.slice(last))
  return <>{out}</>
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
  if (runState?.durationMs !== undefined) return ` · ${formatMs(runState.durationMs)}`
  if (step.actualMs !== null) return ` · ${formatMs(step.actualMs)}`
  return ''
}

function sourceLabel(s: Evidence['source']): string {
  return s === 'auto' ? '上次运行' : s === 'paste' ? '手动粘贴' : '截图'
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
