import { useEffect, useRef, useState } from 'react'
import type { StepKind } from '@qb/core'
import { api, type BaseSuggestion, type DocImportResult, type GraftSource, type Job, type PartialStep, type PurposeStatus } from './api.ts'
import { readAsDataUrl } from './StepCell.tsx'

/**
 * 空 runbook 的入口（宪法 13：从已有的开始）。一个任务可以怎么开始：
 * - 自己写：从空白开始，章节/文字/命令/代码/回显，不需要模型
 * - 导入 md / org 文件：确定性解析，图片一起带上，不需要模型
 * - 从已有的任务挑章节和步骤拼起来（血缘保留，挂在上面的问答跟着来）
 * - 以某个任务为基础（整份复制 + QB 出差异，差异这一步要模型）
 * - 贴一段别人发的文档/脚本/聊天记录，让 QB 整理（要模型）
 * - 让 QB 从空白起草（兜底，要模型）
 */
export function StartPanel({
  taskId,
  title,
  brief,
  job,
  partial,
  llmStatus,
  material,
  onOpenSettings,
  onChanged,
  onStartBlank,
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
  /** 自己写：建空白 runbook 并插第一个块。 */
  onStartBlank: (kind: StepKind) => void
  toast: (text: string, opts?: { tone?: 'error' }) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [bases, setBases] = useState<BaseSuggestion[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const running = job?.status === 'running'
  const elapsed = useElapsed(running ? job!.startedAt : null)
  const modelOk = llmStatus === null || llmStatus.ok

  useEffect(() => {
    api
      .suggestBases(title)
      .then((list) => setBases(list.filter((b) => b.taskId !== taskId)))
      .catch(() => setBases([]))
  }, [title, taskId])

  const startFromBase = (runbookId: string): void => {
    setError(null)
    api
      .basedOn(taskId, runbookId)
      .then(() => {
        onChanged()
        // 有模型时拿这次的说明出差异；没模型就只复制，自己改
        if (modelOk) return api.adapt(taskId, brief.trim() !== '' ? brief.trim() : title).then(() => undefined)
        toast('已复制过来。没配模型，差异要自己对着改（参数面板里改值最快）')
        return undefined
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  if (running) {
    return (
      <div className="start-panel">
        <p className="dim">
          {job!.kind === 'import' ? 'QB 正在从素材整理' : 'QB 正在起草'}
          ……{job!.progress ?? ''} · 已等待 {elapsed} 秒
        </p>
        {partial.map((s, i) => (
          <div className="ghost-step" key={i}>
            {(i === 0 || partial[i - 1]!.section !== s.section) && s.section !== '' && <div className="ghost-section">{s.section}</div>}
            <div className="ghost-title">○ {s.title}</div>
            {s.command !== undefined && <pre className="ghost-cmd">{s.command}</pre>}
          </div>
        ))}
      </div>
    )
  }

  const failure = error ?? (job?.status === 'failed' ? job.error : null)

  return (
    <div className="start-panel">
      <h3>怎么开始？</h3>
      <div className="start-grid">
        <div className="start-card">
          <div className="start-title">自己写</div>
          <div className="dim">从空白开始。命令、说明、参考链接、代码片段、回显都能放，章节可以一层层嵌套。</div>
          <div className="start-actions">
            <button className="btn primary" onClick={() => onStartBlank('command')}>
              写第一条命令
            </button>
            <button className="btn" onClick={() => onStartBlank('section')}>
              先建一章
            </button>
            <button className="btn" onClick={() => onStartBlank('note')}>
              先写说明
            </button>
          </div>
        </div>

        <DocImportCard taskId={taskId} onDone={onChanged} toast={toast} />

        <div className="start-card">
          <div className="start-title">从已有的任务挑</div>
          <div className="dim">挑几个章节或步骤拼起来（问答、参数跟着来）。</div>
          <div className="start-actions">
            <button className="btn" onClick={() => setPickerOpen(true)}>
              挑章节和步骤…
            </button>
          </div>
          {bases !== null && bases.length > 0 && (
            <div className="base-suggestions">
              <div className="dim">或者整份复制一个相似的：</div>
              {bases.slice(0, 4).map((b) => (
                <div key={b.taskId} className="base-row">
                  <span className="base-title">{b.title}</span>
                  <span className="dim">{new Date(b.updatedAt).toLocaleDateString('zh-CN')}</span>
                  <button className="btn" onClick={() => startFromBase(b.runbookId)} title={modelOk ? '复制步骤和参数（血缘保留），再拿这次的说明出差异' : '复制步骤和参数（血缘保留）'}>
                    以它为基础
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="start-card">
          <div className="start-title">让 QB 帮忙 {!modelOk && <span className="verdict unclear">（要先配模型）</span>}</div>
          <div className="dim">贴同事发的文档 / 脚本 / 聊天记录，QB 忠实整理（命令逐字保留）；什么都没有时让 QB 起草。</div>
          {!modelOk ? (
            <div className="start-actions">
              <button className="btn" onClick={onOpenSettings}>
                去配模型
              </button>
            </div>
          ) : (
            <div className="start-actions">
              {material !== null && (
                <button
                  className="btn primary"
                  onClick={() => {
                    setError(null)
                    api.importFromMaterial(taskId, material.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  }}
                >
                  从贴过的素材整理
                </button>
              )}
              <button className="btn" onClick={() => setPasteOpen(true)}>
                贴素材让 QB 整理…
              </button>
              <button
                className="btn ghost"
                title="没有素材也没有相似任务时才用：QB 起草的是猜测，每条命令都会标成'QB 写的'"
                onClick={() => {
                  setError(null)
                  api.draft(taskId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                }}
              >
                让 QB 起草
              </button>
            </div>
          )}
        </div>
      </div>

      {failure !== null && (
        <p className="verdict fail" style={{ whiteSpace: 'pre-wrap' }}>
          {failure}
        </p>
      )}

      {pickerOpen && <GraftDialog taskId={taskId} onClose={() => setPickerOpen(false)} onDone={onChanged} toast={toast} />}
      {pasteOpen && (
        <MaterialDialog
          onClose={() => setPasteOpen(false)}
          onSubmit={async (text) => {
            const m = await api.createMaterial(taskId, { kind: 'doc', text })
            await api.importFromMaterial(taskId, m.id)
            setPasteOpen(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

/** 导入 md / org：选文件（可以连同图片一起选），或者直接粘贴文本。 */
export function DocImportCard({ taskId, onDone, toast, compact = false }: { taskId: string; onDone: () => void; toast: (text: string, opts?: { tone?: 'error' }) => void; compact?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState<DocImportResult | null>(null)

  const run = async (files: File[], pasted: string | null): Promise<void> => {
    setBusy(true)
    try {
      const doc = files.find((f) => /\.(md|markdown|org|txt)$/i.test(f.name))
      const images = files.filter((f) => f.type.startsWith('image/'))
      const body = pasted ?? (doc !== undefined ? await doc.text() : null)
      if (body === null || body.trim() === '') {
        toast('没找到 .md / .org 文件（可以连同里面引用的图片一起选）', { tone: 'error' })
        return
      }
      // 图片一张张先传上去（单个请求体有上限），拿到地址再导入文档
      const imageUrls: Record<string, string> = {}
      for (const img of images) {
        if (img.size > 5 * 1024 * 1024) continue
        imageUrls[img.name] = await api.uploadAttachment(await readAsDataUrl(img), img.type)
      }
      const r = await api.importDoc(taskId, {
        text: body,
        ...(doc !== undefined ? { filename: doc.name } : {}),
        imageUrls,
      })
      setResult(r)
      setPasting(false)
      setText('')
      onDone()
      toast(`导入了 ${r.stats.sections} 个章节、${r.stats.commands} 条命令、${r.stats.notes} 段文字${r.stats.code > 0 ? `、${r.stats.code} 段代码` : ''}${r.stats.outputs > 0 ? `、${r.stats.outputs} 段回显` : ''}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`start-card${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void run([...e.dataTransfer.files], null)
      }}
    >
      <div className="start-title">导入 markdown / org</div>
      {!compact && <div className="dim">自己的笔记直接导进来：标题变章节，代码块变命令/代码/回显，截图跟在命令后面当参考回显。不需要模型。</div>}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".md,.markdown,.org,.txt,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length > 0) void run(files, null)
        }}
      />
      <div className="start-actions">
        <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()} title="可以连同文档里引用的图片一起选（按文件名对上）">
          {busy ? '导入中…' : '选文件…'}
        </button>
        <button className="btn" disabled={busy} onClick={() => setPasting((v) => !v)}>
          粘贴文本
        </button>
        <span className="dim">或把文件拖到这里</span>
      </div>
      {pasting && (
        <>
          <textarea className="mono import-paste" autoFocus rows={8} placeholder={'# 标题\n\n说明……\n\n```sh\ndocker images\n```\n\n或者 org：* 标题 / #+begin_src sh'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="start-actions">
            <button className="btn primary" disabled={busy || text.trim() === ''} onClick={() => void run([], text)}>
              导入
            </button>
          </div>
        </>
      )}
      {result !== null && result.missingImages.length > 0 && (
        <div className="verdict unclear">
          {result.missingImages.length} 张图没带上（{result.missingImages.slice(0, 3).join('、')}
          {result.missingImages.length > 3 ? '…' : ''}）：再选一次文档，连同这些图片一起选
        </div>
      )}
    </div>
  )
}

/** 从已有任务挑章节/步骤：左边选任务，右边勾选（选章节 = 整章）。 */
export function GraftDialog({
  taskId,
  target,
  onClose,
  onDone,
  toast,
}: {
  taskId: string
  /** 接到哪（默认文档末尾）。 */
  target?: { parentId: string | null; afterId: string | null }
  onClose: () => void
  onDone: () => void
  toast: (text: string, opts?: { tone?: 'error' }) => void
}) {
  const [q, setQ] = useState('')
  const [sources, setSources] = useState<GraftSource[] | null>(null)
  const [picked, setPicked] = useState<GraftSource | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .graftSources(taskId, q)
        .then(setSources)
        .catch(() => setSources([]))
    }, 200)
    return () => clearTimeout(t)
  }, [q, taskId])

  const depthOf = (steps: GraftSource['steps'], s: GraftSource['steps'][number]): number => {
    let d = 0
    let p = s.parentId
    while (p !== null) {
      d++
      p = steps.find((x) => x.id === p)?.parentId ?? null
    }
    return d
  }
  // 勾了祖先的，子孙自动算在里面（显示成勾上、不能单独取消）
  const covered = (s: GraftSource['steps'][number]): boolean => {
    if (picked === null) return false
    let p = s.parentId
    while (p !== null) {
      if (chosen.has(p)) return true
      p = picked.steps.find((x) => x.id === p)?.parentId ?? null
    }
    return false
  }

  const submit = async (): Promise<void> => {
    if (picked === null || chosen.size === 0) return
    setBusy(true)
    try {
      const r = await api.graft(taskId, { sourceTaskId: picked.taskId, stepIds: [...chosen], ...(target ?? {}) })
      toast(`从「${picked.title}」接过来 ${r.inserted.length} 块${r.addedParams.length > 0 ? `，带上了参数 ${r.addedParams.join('、')}` : ''}`)
      onDone()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide graft" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h3>从已有的任务挑章节和步骤</h3>
        <div className="graft-body">
          <div className="graft-sources">
            <input className="inline-edit" placeholder="搜任务标题" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            {sources === null && <div className="dim">读取中…</div>}
            {sources !== null && sources.length === 0 && <div className="dim">没有别的有内容的任务。同事的手册要等团队底稿库（下一阶段）。</div>}
            {(sources ?? []).map((s) => (
              <button
                key={s.taskId}
                className={`task-item${picked?.taskId === s.taskId ? ' active' : ''}`}
                onClick={() => {
                  setPicked(s)
                  setChosen(new Set())
                }}
              >
                <span className="title">{s.title}</span>
                <span className="dim">{s.steps.length}</span>
              </button>
            ))}
          </div>
          <div className="graft-steps">
            {picked === null ? (
              <div className="dim">先在左边选一个任务</div>
            ) : (
              picked.steps.map((s) => {
                const inherit = covered(s)
                return (
                  <label key={s.id} className={`graft-row kind-${s.kind}`} style={{ paddingLeft: 6 + depthOf(picked.steps, s) * 16 }}>
                    <input
                      type="checkbox"
                      checked={inherit || chosen.has(s.id)}
                      disabled={inherit}
                      onChange={(e) =>
                        setChosen((c) => {
                          const next = new Set(c)
                          if (e.target.checked) next.add(s.id)
                          else next.delete(s.id)
                          return next
                        })
                      }
                    />
                    <span className="graft-kind">{KIND_MARK[s.kind]}</span>
                    <span>{s.title}</span>
                  </label>
                )
              })
            )}
          </div>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy || picked === null || chosen.size === 0} onClick={() => void submit()}>
            接过来{chosen.size > 0 ? `（${chosen.size} 项）` : ''}
          </button>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <span className="dim">勾章节就是整章；血缘保留，挂在上面的问答会跟过来</span>
        </div>
      </div>
    </div>
  )
}

const KIND_MARK: Record<StepKind, string> = {
  section: '§',
  note: '¶',
  code: '{}',
  output: '⎘',
  command: '$',
  check: '✓?',
  wait: '⏳',
  manual: '✋',
  decision: '?',
  delegate: '→',
}

export function kindMark(kind: StepKind): string {
  return KIND_MARK[kind]
}

/** 贴素材让 QB 整理（要模型）。 */
function MaterialDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h3>贴素材让 QB 整理</h3>
        <p className="dim">同事发的文档 / 脚本 / 聊天记录 / 终端日志。QB 忠实整理：命令逐字保留、提取参数、标出改写与缺口。自己的 md / org 笔记用"导入"更快（不需要模型）。</p>
        <textarea className="mono" autoFocus rows={12} value={text} onChange={(e) => setText(e.target.value)} />
        {error !== null && <div className="verdict fail">{error}</div>}
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || text.trim() === ''}
            onClick={() => {
              setBusy(true)
              setError(null)
              onSubmit(text)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '交给 QB…' : '让 QB 整理'}
          </button>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/** 起草期间显示已等待时长。干等一个不知道要多久的转圈是最烦人的。 */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  return since === null ? 0 : Math.floor((now - since) / 1000)
}
