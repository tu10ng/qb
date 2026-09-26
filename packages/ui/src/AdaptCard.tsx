import { useMemo, useState } from 'react'
import type { Param, Step } from '@qb/core'
import { api, type AdaptProposal } from './api.ts'

interface Props {
  taskId: string
  steps: Step[]
  params: Param[]
  /** 模型给的差异（job 的 result）。 */
  proposal: AdaptProposal
  onApplied: () => void
  onDismiss: () => void
  toast: (text: string, opts?: { tone?: 'error' }) => void
}

/**
 * 差异卡片（模式 A 的"逐项接受" / 情况变了的重规划）。
 *
 * 默认全选参数改动与新参数；命令修改、作废建议、疑问逐项勾选。
 * 模型给出的步骤序号在这里映射回 stepId。
 */
export function AdaptCard({ taskId, steps, params, proposal, onApplied, onDismiss, toast }: Props) {
  const [selectedEdits, setSelectedEdits] = useState<Set<number>>(
    () => new Set(proposal.stepEdits.map((_, i) => i)),
  )
  const [busy, setBusy] = useState(false)

  // 序号 → stepId：与提示词里的编号规则一致（跳过顶层章节标题）
  const stepIdOf = useMemo(() => {
    const indexed = steps.map((s, index) => ({ s, index })).filter(({ s }) => s.kind !== 'note' || s.parentId !== null)
    return new Map(indexed.map(({ s, index }) => [index, s.id]))
  }, [steps])

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const stepEdits = proposal.stepEdits
        .filter((_, i) => selectedEdits.has(i))
        .map((e) => ({ stepId: stepIdOf.get(e.stepIndex), command: e.command }))
        .filter((e): e is { stepId: string; command: string } => e.stepId !== undefined)
      const r = await api.adaptApply(taskId, {
        paramChanges: proposal.paramChanges.map((c) => ({ name: c.name, to: c.to })),
        newParams: proposal.newParams,
        stepEdits,
      })
      toast(r.summary)
      onApplied()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const empty =
    proposal.paramChanges.length === 0 &&
    proposal.newParams.length === 0 &&
    proposal.stepEdits.length === 0

  return (
    <div className="adapt-card">
      <div className="adapt-head">
        <strong>这次的差异</strong>
        <span className="dim">{empty ? 'QB 没找到需要改的地方' : '逐项核对后应用；不想要的取消勾选'}</span>
      </div>

      {proposal.paramChanges.length > 0 && (
        <div className="adapt-group">
          <span className="adapt-label">参数改动</span>
          {proposal.paramChanges.map((c) => (
            <div key={c.name} className="adapt-item">
              <code>{c.name}</code>
              <span className="old">{params.find((p) => p.name === c.name)?.value ?? '（新）'}</span>
              <span className="arrow">→</span>
              <code className="new">{c.to === '' ? '（待确认，先留空）' : c.to}</code>
              {c.reason !== undefined && <span className="dim"> {c.reason}</span>}
            </div>
          ))}
        </div>
      )}

      {proposal.newParams.length > 0 && (
        <div className="adapt-group">
          <span className="adapt-label">新参数</span>
          {proposal.newParams.map((p) => (
            <div key={p.name} className="adapt-item">
              <code>{p.name}</code>
              <code className="new">{p.value === '' ? '（说明里没讲清，需要问）' : p.value}</code>
              {p.description !== undefined && <span className="dim"> {p.description}</span>}
            </div>
          ))}
        </div>
      )}

      {proposal.stepEdits.map((e, i) => {
        const title = steps.filter((s) => s.kind !== 'note' || s.parentId !== null)[e.stepIndex]?.title
        return (
          <label key={i} className="adapt-item check">
            <input
              type="checkbox"
              checked={selectedEdits.has(i)}
              onChange={(ev) =>
                setSelectedEdits((s) => {
                  const next = new Set(s)
                  if (ev.target.checked) next.add(i)
                  else next.delete(i)
                  return next
                })
              }
            />
            <span>
              改命令：{title ?? `第 ${e.stepIndex} 步`}
              <pre className="adapt-cmd">{e.command}</pre>
              {e.reason !== undefined && <span className="dim">{e.reason}</span>}
            </span>
          </label>
        )
      })}

      {proposal.obsolete.length > 0 && (
        <div className="adapt-group">
          <span className="adapt-label">可能不再适用（仅建议，QB 会误判）</span>
          {proposal.obsolete.map((o, i) => (
            <div key={i} className="adapt-item dim">
              ⚠ {o.what}
              {o.reason !== undefined ? `（${o.reason}）` : ''}
            </div>
          ))}
        </div>
      )}

      {proposal.questions.length > 0 && (
        <div className="adapt-group">
          <span className="adapt-label">要问发起人的</span>
          {proposal.questions.map((q, i) => (
            <div key={i} className="adapt-item">
              <span>？{q}</span>
              <button
                className="btn ghost"
                title="临时 · 复制到 IM"
                onClick={() => {
                  void navigator.clipboard.writeText(q)
                  toast('问题已复制，贴到 IM 里发给发起人（临时 · 复制到 IM）')
                }}
              >
                问发起人
              </button>
            </div>
          ))}
        </div>
      )}

      {proposal.rejectedStepEdits.length > 0 && (
        <div className="dim">
          另有 {proposal.rejectedStepEdits.length} 处命令修改因步骤序号对不上被丢弃
        </div>
      )}

      <div className="adapt-actions">
        <button className="btn primary" disabled={busy || empty} onClick={() => void apply()}>
          应用所选
        </button>
        <button className="btn ghost" disabled={busy} onClick={onDismiss}>
          先不用
        </button>
      </div>
    </div>
  )
}
