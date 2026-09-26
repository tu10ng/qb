import { describe, expect, it } from 'vitest'
import { checkExpectation, type ExpectationInput } from '../src/expectation.ts'

const base: ExpectationInput = { exitCode: 0, stdout: '', stderr: '', timedOut: false }

describe('checkExpectation', () => {
  it('超时压倒一切预期', () => {
    const r = checkExpectation({ kind: 'contains', text: 'ok', caseSensitive: true }, {
      ...base,
      stdout: 'ok',
      timedOut: true,
    })
    expect(r.verdict).toBe('fail')
    expect(r.reason).toContain('超时')
  })

  describe('无预期时退化为退出码判定', () => {
    it('退出码 0 通过', () => {
      expect(checkExpectation(null, base).verdict).toBe('pass')
    })

    it('非 0 失败', () => {
      expect(checkExpectation(null, { ...base, exitCode: 1 }).verdict).toBe('fail')
    })

    it('被信号终止时不确定', () => {
      expect(checkExpectation(null, { ...base, exitCode: null }).verdict).toBe('unclear')
    })
  })

  describe('exitCode', () => {
    it('匹配指定退出码', () => {
      const e = { kind: 'exitCode', code: 2 } as const
      expect(checkExpectation(e, { ...base, exitCode: 2 }).verdict).toBe('pass')
      expect(checkExpectation(e, { ...base, exitCode: 0 }).verdict).toBe('fail')
    })
  })

  describe('contains', () => {
    it('大小写敏感', () => {
      const e = { kind: 'contains', text: 'Started', caseSensitive: true } as const
      expect(checkExpectation(e, { ...base, stdout: 'Started server' }).verdict).toBe('pass')
      expect(checkExpectation(e, { ...base, stdout: 'started server' }).verdict).toBe('fail')
    })

    it('大小写不敏感', () => {
      const e = { kind: 'contains', text: 'Started', caseSensitive: false } as const
      expect(checkExpectation(e, { ...base, stdout: 'started server' }).verdict).toBe('pass')
    })

    it('也检查 stderr（很多程序把进度写 stderr）', () => {
      const e = { kind: 'contains', text: 'Loading', caseSensitive: true } as const
      expect(checkExpectation(e, { ...base, stderr: 'Loading weights...' }).verdict).toBe('pass')
    })
  })

  describe('notContains', () => {
    it('出现禁止内容则失败', () => {
      const e = { kind: 'notContains', text: 'CUDA out of memory' } as const
      expect(checkExpectation(e, { ...base, stderr: 'CUDA out of memory' }).verdict).toBe('fail')
      expect(checkExpectation(e, { ...base, stdout: 'fine' }).verdict).toBe('pass')
    })
  })

  describe('regex', () => {
    it('匹配模式', () => {
      const e = { kind: 'regex', pattern: 'Started server.*\\d+s', flags: '' } as const
      expect(checkExpectation(e, { ...base, stdout: 'Started server in 12s' }).verdict).toBe('pass')
      expect(checkExpectation(e, { ...base, stdout: 'Started server' }).verdict).toBe('fail')
    })

    it('正则本身写错时不确定（是计划的问题，不是执行失败）', () => {
      const e = { kind: 'regex', pattern: '([unclosed', flags: '' } as const
      const r = checkExpectation(e, { ...base, stdout: 'anything' })
      expect(r.verdict).toBe('unclear')
      expect(r.reason).toContain('无法解析')
    })
  })

  describe('manual', () => {
    it('总是返回 unclear 并带上描述', () => {
      const e = { kind: 'manual', description: '确认页面显示了新版本号' } as const
      const r = checkExpectation(e, base)
      expect(r.verdict).toBe('unclear')
      expect(r.reason).toBe('确认页面显示了新版本号')
    })
  })
})
