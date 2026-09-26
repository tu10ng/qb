import { useState } from 'react'
import type { Step } from '@qb/core'
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
export function StepCell({ step, current, runState, onFocus, onChanged }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [danger, setDanger] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState<string | null>(null)

  const running = runState?.running ?? false

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

  const copy = (): void => {
    if (step.command !== null) void navigator.clipboard.writeText(step.command)
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
                    copy()
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

        {step.expectation !== null && (
          <div className="expectation">
            <span className="label">预期：</span>
            {describeExpectation(step.expectation)}
          </div>
        )}

        {(runState !== undefined || pasted !== null) && (
          <div className="output">
            <span className="label">输出：</span>
            <div className="output-box">
              {runState?.output ?? pasted ?? ''}
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
          </div>
        )}

        {/* 手动跑完可以把结果贴回来——文本或截图都行 */}
        {step.command !== null && runState === undefined && (
          <textarea
            className="inline-edit paste-area"
            placeholder="手动跑的话，把输出粘贴到这里（也可以直接贴截图）"
            rows={1}
            onClick={(e) => e.stopPropagation()}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text')
              if (text !== '') setPasted(text)
            }}
            style={{ marginTop: 7, fontSize: 12.5, color: 'var(--text-dim)' }}
          />
        )}

        {error !== null && <div className="verdict fail">{error}</div>}

        <div className="step-actions" onClick={(e) => e.stopPropagation()}>
          {running ? (
            <button className="btn" onClick={() => void api.cancelStep(step.id).then(onChanged)}>
              取消
            </button>
          ) : (
            <>
              <button className="btn ghost">完成</button>
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
  if (step.expectedMinutes !== null) parts.push(`预计 ${step.expectedMinutes} 分钟`)
  if (runState?.durationMs !== undefined) parts.push(formatMs(runState.durationMs))
  else if (step.actualMs !== null) parts.push(formatMs(step.actualMs))
  return parts.join(' · ')
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

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
