import { useState } from 'react'
import type { Evidence, Step } from '@qb/core'
import { ApiError, api } from './api.ts'

export interface StepRunState {
  output: string
  running: boolean
  verdict?: 'pass' | 'fail' | 'unclear'
  reason?: string
  durationMs?: number
  redactionHits?: string[]
}

interface Props {
  step: Step
  current: boolean
  runState: StepRunState | undefined
  /** 历史证据（上次跑的输出、手动贴的内容）。 */
  evidence: Evidence[]
  onFocus: () => void
  onChanged: () => void
}

/**
 * 一个步骤单元。
 *
 * 产品宪法在这里的落点：
 * - 一切细节在原地可见（为什么/命令/预期/输出），不藏在弹窗
 * - 不当保姆：运行、复制、手动跑后粘贴、直接标记完成，随用户喜好
 * - 破坏性命令红框 + 内联确认开关，不弹窗
 */
export function StepCell({ step, current, runState, evidence, onFocus, onChanged }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [danger, setDanger] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const running = runState?.running ?? false
  // 本次运行的实时输出优先；没有就显示历史证据
  const lastEvidence = evidence.length > 0 ? evidence[evidence.length - 1]! : null
  const shownOutput = runState?.output ?? lastEvidence?.text ?? null

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

  const isDangerous = danger !== null

  return (
    <div className={`step${current ? ' current' : ''}`} onClick={onFocus}>
      <div className="step-head">
        <span className={`step-mark ${markClass(step, running)}`}>{mark(step, running)}</span>
        <span className="step-title">{step.title}</span>
        <span className="step-hint">{hint(step, runState)}</span>
      </div>

      {step.whyMd !== null && (
        <div className="step-why">
          {step.whyMd}
          {step.whySource !== null && <span className="source"> — {step.whySource}</span>}
        </div>
      )}

      <div className="step-body">
        {step.command !== null && (
          <>
            <div className={`cmd${isDangerous ? ' destructive' : ''}`}>
              <pre>{step.command}</pre>
              <div className="actions">
                <button
                  className="btn primary"
                  onClick={(e) => {
                    e.stopPropagation()
                    void run()
                  }}
                  disabled={running || (isDangerous && !confirmed)}
                >
                  {running ? '运行中' : '▶ 运行'}
                </button>
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigator.clipboard.writeText(step.command!)
                  }}
                >
                  ⧉ 复制
                </button>
              </div>
            </div>

            {isDangerous && (
              <div className="danger-note">
                <span>⚠ {danger.join('、')}</span>
                <label onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我确认要运行
                </label>
              </div>
            )}
          </>
        )}

        {step.probe !== null && (
          <div className="expectation">
            <span className="label">就绪条件：</span>
            {describeProbe(step.probe)}
          </div>
        )}

        {step.expectation !== null && (
          <div className="expectation">
            <span className="label">预期：</span>
            {describeExpectation(step.expectation)}
          </div>
        )}

        {shownOutput !== null && (
          <div className="output">
            <span className="label">
              输出{lastEvidence !== null && runState === undefined ? `（${sourceLabel(lastEvidence.source)}）` : ''}：
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
            {lastEvidence?.redacted === true && runState === undefined && (
              <div className="paste-hint">已脱敏</div>
            )}
          </div>
        )}

        {/* 手动跑完可以贴回来——文本或截图都行 */}
        {!running && (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              className="inline-edit"
              placeholder={
                step.command !== null
                  ? '自己跑的话，把输出粘贴到这里'
                  : '做完了？可以写点什么（可选）'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={draft === '' ? 1 : 4}
              style={{ marginTop: 7, fontSize: 12.5, fontFamily: 'var(--mono)' }}
            />
            {draft !== '' && (
              <button
                className="btn primary"
                style={{ marginTop: 5 }}
                disabled={busy}
                onClick={() => void submit({ text: draft })}
              >
                提交输出
              </button>
            )}
          </div>
        )}

        {error !== null && <div className="verdict fail">{error}</div>}

        <div className="step-actions" onClick={(e) => e.stopPropagation()}>
          {running ? (
            <button className="btn" onClick={() => void api.cancelStep(step.id).then(onChanged)}>
              取消
            </button>
          ) : (
            <>
              <button
                className="btn ghost"
                disabled={busy || step.status === 'ok'}
                onClick={() => void submit({ markDone: true })}
              >
                完成
              </button>
              <button className="btn ghost">跳过</button>
              <button className="btn ghost">失败…</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
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

function hint(step: Step, runState: StepRunState | undefined): string {
  const parts: string[] = []
  if (step.expectedMinutes !== null) parts.push(`预计 ${formatMinutes(step.expectedMinutes)}`)
  if (runState?.durationMs !== undefined) parts.push(formatMs(runState.durationMs))
  else if (step.actualMs !== null) parts.push(formatMs(step.actualMs))
  return parts.join(' · ')
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
