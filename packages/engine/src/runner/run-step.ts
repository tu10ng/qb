import {
  assessDanger,
  checkExpectation,
  redact,
  type DangerLevel,
  type Expectation,
  type Verdict,
} from '@qb/core'
import type { HostPort, OutputChunk, RunResult } from '../dsh/port.ts'

export interface StepRunInput {
  stepId: string
  command: string
  expectation: Expectation | null
  timeoutMs: number
  cwd?: string
  env?: Record<string, string>
  /** 用户已在红框上点过"确认运行"。 */
  confirmed?: boolean
}

export interface StepRunOutcome {
  stepId: string
  verdict: Verdict
  reason: string
  result: RunResult
  /** 脱敏后的输出，这是唯一允许持久化和上传的版本。 */
  redactedStdout: string
  redactedStderr: string
  redactionHits: string[]
  danger: DangerLevel
}

/**
 * 破坏性命令未确认时抛这个，上层转成 409 让前端亮红框。
 *
 * 注意：这里不能用构造函数参数属性（`constructor(readonly x: string)`）。
 * dsh 用 Node 的 strip-only 模式加载插件源码，那种语法需要真正的
 * 代码生成，会在加载时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 * 同理，本包内禁用 enum、namespace、装饰器、参数属性。
 */
export class NeedsConfirmation extends Error {
  readonly command: string
  readonly matched: string[]

  constructor(command: string, matched: string[]) {
    super(`命令需要确认：${matched.join('、')}`)
    this.name = 'NeedsConfirmation'
    this.command = command
    this.matched = matched
  }
}

export interface StepRunHandle {
  onChunk(cb: (chunk: OutputChunk) => void): () => void
  readonly outcome: Promise<StepRunOutcome>
  cancel(): boolean
}

/**
 * 执行一步。
 *
 * 语义要点（对应产品宪法）：
 * - 不弹窗、不拦截。只有 destructive 级别且未确认才拒绝，让 UI 亮红框。
 * - 输出先脱敏再落库，原文不出本机。
 * - 预期判定确定性优先，unclear 才需要模型介入（本函数不调模型，
 *   把 unclear 原样返回，由上层决定是否唤醒 QB）。
 *
 * 脱敏边界：流式 chunk 也做脱敏。虽然 WS 是本机同源、原文在本机终端里
 * 本来就看得到，但流式内容会进浏览器的内存与 devtools，且我们希望
 * "任何离开执行进程的输出都是脱敏的"这条规则没有例外——有例外的规则
 * 迟早会在某个调用点被忘掉。
 */
export function runStep(host: HostPort, input: StepRunInput): StepRunHandle {
  const danger = assessDanger(input.command)

  if (danger.level === 'destructive' && input.confirmed !== true) {
    throw new NeedsConfirmation(input.command, danger.matched)
  }

  const run = host.startCommand({
    command: input.command,
    timeoutMs: input.timeoutMs,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  })

  const outcome = run.done.then((result): StepRunOutcome => {
    const outRedaction = redact(result.stdout)
    const errRedaction = redact(result.stderr)

    // 判定用原始输出（脱敏可能改变匹配结果，比如把 token 换成 ***
    // 会让 contains 检查失效）。
    const check = checkExpectation(input.expectation, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    })

    return {
      stepId: input.stepId,
      verdict: check.verdict,
      reason: check.reason,
      result,
      redactedStdout: outRedaction.text,
      redactedStderr: errRedaction.text,
      redactionHits: [...new Set([...outRedaction.hits, ...errRedaction.hits])],
      danger: danger.level,
    }
  })

  return {
    onChunk(cb) {
      return run.onChunk((chunk) => {
        const { text, hits } = redact(chunk.text)
        cb(hits.length > 0 ? { ...chunk, text } : chunk)
      })
    },
    outcome,
    cancel: () => run.kill(),
  }
}
