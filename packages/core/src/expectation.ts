import type { Expectation } from './schema.ts'

export type Verdict = 'pass' | 'fail' | 'unclear'

export interface ExpectationInput {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ExpectationResult {
  verdict: Verdict
  reason: string
}

/**
 * 判定一步的执行结果是否符合预期。
 *
 * 设计要点：确定性的判定在本地做完，只有真正需要读懂输出的情况才返回
 * unclear 交给模型。这样绝大多数步骤零 token、零延迟，且结果可复现。
 */
export function checkExpectation(
  expectation: Expectation | null,
  input: ExpectationInput,
): ExpectationResult {
  // 超时优先于一切：无论预期是什么，超时都是失败。
  if (input.timedOut) {
    return { verdict: 'fail', reason: '执行超时' }
  }

  // 没有声明预期时退化为退出码判定，这是最不意外的默认行为。
  if (expectation === null) {
    if (input.exitCode === null) {
      return { verdict: 'unclear', reason: '进程被信号终止，无退出码' }
    }
    return input.exitCode === 0
      ? { verdict: 'pass', reason: '退出码 0' }
      : { verdict: 'fail', reason: `退出码 ${input.exitCode}` }
  }

  switch (expectation.kind) {
    case 'exitCode': {
      if (input.exitCode === null) {
        return { verdict: 'unclear', reason: '进程被信号终止，无退出码' }
      }
      return input.exitCode === expectation.code
        ? { verdict: 'pass', reason: `退出码 ${expectation.code}` }
        : { verdict: 'fail', reason: `期望退出码 ${expectation.code}，实际 ${input.exitCode}` }
    }

    case 'contains': {
      const haystack = combinedOutput(input)
      const found = expectation.caseSensitive
        ? haystack.includes(expectation.text)
        : haystack.toLowerCase().includes(expectation.text.toLowerCase())
      return found
        ? { verdict: 'pass', reason: `输出包含 "${expectation.text}"` }
        : { verdict: 'fail', reason: `输出未包含 "${expectation.text}"` }
    }

    case 'notContains': {
      const haystack = combinedOutput(input)
      return haystack.includes(expectation.text)
        ? { verdict: 'fail', reason: `输出出现了不应出现的 "${expectation.text}"` }
        : { verdict: 'pass', reason: `输出未出现 "${expectation.text}"` }
    }

    case 'regex': {
      let re: RegExp
      try {
        re = new RegExp(expectation.pattern, expectation.flags)
      } catch {
        // 正则本身写错了是计划的问题，不该判执行失败。
        return { verdict: 'unclear', reason: `预期正则无法解析：${expectation.pattern}` }
      }
      return re.test(combinedOutput(input))
        ? { verdict: 'pass', reason: `输出匹配 /${expectation.pattern}/` }
        : { verdict: 'fail', reason: `输出不匹配 /${expectation.pattern}/` }
    }

    case 'manual':
      return { verdict: 'unclear', reason: expectation.description }
  }
}

function combinedOutput(input: ExpectationInput): string {
  return input.stderr ? `${input.stdout}\n${input.stderr}` : input.stdout
}
