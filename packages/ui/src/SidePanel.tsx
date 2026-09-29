import { useMemo, useState } from 'react'
import type { Event, Param, Step } from '@qb/core'
import { isContent, paramRefs, sectionOf } from '@qb/core'
import { api, type QaItem } from './api.ts'
import { QaForm, QaRow, formatMs } from './StepCell.tsx'

type Tab = 'here' | 'qa' | 'log'

/**
 * 右侧面板：原来是一条流水账（插入一步、改了这一步的 params……），没用。
 * 现在分三栏：
 * - 这一步：选中的这一步相关的一切——问答、用到的参数、发起人的留言、
 *   QB 替你说了什么、这一步的最近动作
 * - 问答：整份文档的问答（问和答可以只有一个；没答案的可以问发起人）
 * - 记录：完整的时间线（默认只看重要的，编辑/插入这类折叠）
 */
export function SidePanel({
  steps,
  params,
  events,
  qa,
  current,
  taskId,
  ended,
  onClose,
  onChanged,
  onAsk,
  onFocusParam,
  eventText,
  renderAlertAction,
}: {
  steps: Step[]
  params: Param[]
  events: Event[]
  qa: QaItem[]
  current: Step | null
  taskId: string
  ended: boolean
  onClose: () => void
  onChanged: () => void
  /** 问发起人（带上某条问答或这一步）。 */
  onAsk: (opts: { stepId: string | null; lessonId?: string; question?: string }) => void
  onFocusParam: (name: string) => void
  eventText: (e: Event) => string
  renderAlertAction: (e: Event) => React.ReactNode
}) {
  const [tab, setTab] = useState<Tab>('here')
  const [adding, setAdding] = useState<'step' | 'doc' | null>(null)
  const [showAll, setShowAll] = useState(false)

  const here = current !== null ? qa.filter((q) => q.stepId === current.id) : []
  const section = current !== null ? sectionOf(steps, current) : null
  const inSection = section !== null && section.id !== current?.id ? qa.filter((q) => q.stepId === section.id) : []
  const docQa = qa.filter((q) => q.stepId === null)
  const open = qa.filter((q) => q.question !== '' && q.answer === '')

  const usedParams = useMemo(() => {
    if (current === null) return []
    const names = paramRefs(`${current.command ?? ''}\n${current.bodyMd ?? ''}`)
    return names.map((n) => params.find((p) => p.name === n)).filter((p): p is Param => p !== undefined)
  }, [current, params])

  const hereEvents = current !== null ? events.filter((e) => e.stepId === current.id) : []
  const talk = hereEvents.filter((e) => e.kind === 'comment' || e.kind === 'question_answered' || e.kind === 'alert_raised' || e.kind === 'lesson_shared')
  const recent = hereEvents.filter((e) => IMPORTANT.has(e.kind) && !talk.includes(e)).slice(-5)

  const logEvents = (showAll ? events : events.filter((e) => IMPORTANT.has(e.kind) || e.kind === 'alert_raised')).slice().reverse()

  return (
    <>
      <div className="panel-tabs">
        <button className={tab === 'here' ? 'on' : ''} onClick={() => setTab('here')}>
          这一步
        </button>
        <button className={tab === 'qa' ? 'on' : ''} onClick={() => setTab('qa')}>
          问答{qa.length > 0 ? ` ${qa.length}` : ''}
          {open.length > 0 && <span className="badge">{open.length}</span>}
        </button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          记录
        </button>
        <span className="spacer" />
        <button className="btn ghost drawer-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="qb-feed">
        {tab === 'here' &&
          (current === null ? (
            <p className="dim">点正文里的某一块，这里显示它的问答、用到的参数和留言。</p>
          ) : (
            <>
              <div className="here-title">
                {current.title}
                {current.actualMs !== null && <span className="dim"> · {formatMs(current.actualMs)}</span>}
              </div>

              <div className="here-section">
                <div className="here-label">
                  问答
                  <span className="spacer" />
                  <button className="btn ghost" onClick={() => setAdding('step')}>
                    ＋ 记一条
                  </button>
                </div>
                {adding === 'step' && (
                  <QaForm
                    withScope
                    onCancel={() => setAdding(null)}
                    onSubmit={async (v) => {
                      await api.addQa(taskId, { question: v.question, answer: v.answer, stepId: current.id, condition: v.condition === '' ? null : v.condition, scope: v.scope })
                      setAdding(null)
                      onChanged()
                    }}
                  />
                )}
                {here.length === 0 && inSection.length === 0 && adding !== 'step' && <div className="dim">这一步还没有问答。踩了坑、问了人、有个疑问，都可以记一条（问和答可以只写一个）。</div>}
                {here.map((q) => (
                  <QaRow key={q.id} item={q} step={current} open={false} onChanged={onChanged} actions={askActions(q, current, onAsk)} />
                ))}
                {inSection.length > 0 && (
                  <>
                    <div className="dim">「{section!.title}」这一章的：</div>
                    {inSection.map((q) => (
                      <QaRow key={q.id} item={q} step={null} open={false} onChanged={onChanged} actions={askActions(q, section!, onAsk)} />
                    ))}
                  </>
                )}
              </div>

              {usedParams.length > 0 && (
                <div className="here-section">
                  <div className="here-label">用到的参数</div>
                  {usedParams.map((p) => (
                    <button key={p.name} className="param-chip" onClick={() => onFocusParam(p.name)} title="去参数面板改">
                      <code>{p.name}</code> = {p.secret ? '••••' : p.value === '' ? <span className="verdict fail">（缺）</span> : p.value}
                    </button>
                  ))}
                </div>
              )}

              {talk.length > 0 && (
                <div className="here-section">
                  <div className="here-label">留言与回答</div>
                  {talk.map((e) => (
                    <div className={`qb-msg${e.kind === 'alert_raised' ? ' raised' : ''}`} key={e.id}>
                      {eventText(e)}
                      {!ended && renderAlertAction(e)}
                      <div className="when">{new Date(e.createdAt).toLocaleString('zh-CN')}</div>
                    </div>
                  ))}
                </div>
              )}

              {!isContent(current) && recent.length > 0 && (
                <div className="here-section">
                  <div className="here-label">最近</div>
                  {recent.map((e) => (
                    <div className="qb-msg" key={e.id}>
                      {eventText(e)}
                      <div className="when">{new Date(e.createdAt).toLocaleString('zh-CN')}</div>
                    </div>
                  ))}
                </div>
              )}

              {!ended && (
                <div className="here-section">
                  <button className="btn" onClick={() => onAsk({ stepId: current.id })}>
                    就这一步问发起人
                  </button>
                </div>
              )}
            </>
          ))}

        {tab === 'qa' && (
          <>
            <div className="here-label">
              整份文档的问答
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setAdding('doc')}>
                ＋ 记一条
              </button>
            </div>
            {adding === 'doc' && (
              <QaForm
                withScope
                onCancel={() => setAdding(null)}
                onSubmit={async (v) => {
                  await api.addQa(taskId, { question: v.question, answer: v.answer, stepId: null, condition: v.condition === '' ? null : v.condition, scope: v.scope })
                  setAdding(null)
                  onChanged()
                }}
              />
            )}
            {qa.length === 0 && adding !== 'doc' && (
              <p className="dim">还没有问答。问答可以挂在某一步、某一章或整份文档上；只有问没有答的，可以一键问发起人，回答回来自动填上。</p>
            )}
            {docQa.map((q) => (
              <QaRow key={q.id} item={q} step={null} open={false} onChanged={onChanged} actions={askActions(q, null, onAsk)} />
            ))}
            {qa
              .filter((q) => q.stepId !== null)
              .map((q) => (
                <div key={q.id}>
                  <div className="qa-where">{q.stepTitle}</div>
                  <QaRow item={q} step={steps.find((s) => s.id === q.stepId) ?? null} open={false} onChanged={onChanged} actions={askActions(q, steps.find((s) => s.id === q.stepId) ?? null, onAsk)} />
                </div>
              ))}
          </>
        )}

        {tab === 'log' && (
          <>
            <label className="dim" style={{ display: 'block', marginBottom: 8 }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 也显示编辑、插入、移动
            </label>
            {logEvents.length === 0 ? (
              <p className="dim">还没有事件。</p>
            ) : (
              logEvents.map((e) => (
                <div className={`qb-msg${e.kind === 'alert_raised' ? ' raised' : ''}`} key={e.id}>
                  {eventText(e)}
                  {!ended && renderAlertAction(e)}
                  <div className="when">{new Date(e.createdAt).toLocaleString('zh-CN')}</div>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </>
  )
}

/** 问答行上的"问发起人"：没答案的问题直接拿去问，回答回来填进它的答。 */
function askActions(q: QaItem, step: Step | null, onAsk: (opts: { stepId: string | null; lessonId?: string; question?: string }) => void): { ask: () => void } {
  return { ask: () => onAsk({ stepId: step?.id ?? null, lessonId: q.id, question: q.question }) }
}

/** 记录栏默认显示的：执行结果、状态、沟通。编辑、插入、移动折叠起来。 */
const IMPORTANT = new Set<Event['kind']>([
  'step_run',
  'step_ok',
  'step_failed',
  'step_timeout',
  'step_skipped',
  'task_created',
  'task_updated',
  'task_started',
  'task_done',
  'task_blocked',
  'task_resumed',
  'task_abandoned',
  'task_reopened',
  'situation_changed',
  'question_asked',
  'question_answered',
  'comment',
  'alert_acked',
  'alert_snoozed',
  'delegate_progress',
  'lesson_proposed',
  'lesson_confirmed',
  'lesson_shared',
  'base_proposal',
  'replanned',
])
