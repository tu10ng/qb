import { describe, expect, it } from 'vitest'
import { NeedsConfirmation, runStep } from '../src/runner/run-step.ts'
import { FakeHost } from './fake-host.ts'

describe('runStep', () => {
  it('成功的命令判定为 pass', async () => {
    const host = new FakeHost()
    host.setScript([{ stdout: 'Started server\n', exitCode: 0 }])

    const handle = runStep(host, {
      stepId: 'stp_1',
      command: 'vllm serve /models/qwen',
      expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
      timeoutMs: 60_000,
    })

    const outcome = await handle.outcome
    expect(outcome.verdict).toBe('pass')
    expect(outcome.danger).toBe('safe')
  })

  it('输出不符预期时判定为 fail', async () => {
    const host = new FakeHost()
    host.setScript([{ stdout: 'Error: port in use\n', exitCode: 1 }])

    const handle = runStep(host, {
      stepId: 'stp_1',
      command: 'vllm serve /models/qwen',
      expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
      timeoutMs: 60_000,
    })

    const outcome = await handle.outcome
    expect(outcome.verdict).toBe('fail')
  })

  it('超时判定为 fail 且带超时标记', async () => {
    const host = new FakeHost()
    host.setScript([{ timedOut: true, exitCode: null }])

    const handle = runStep(host, {
      stepId: 'stp_1',
      command: 'sleep 999',
      expectation: null,
      timeoutMs: 800,
    })

    const outcome = await handle.outcome
    expect(outcome.verdict).toBe('fail')
    expect(outcome.result.timedOut).toBe(true)
    expect(outcome.reason).toContain('超时')
  })

  describe('破坏性命令', () => {
    it('未确认时抛 NeedsConfirmation', () => {
      const host = new FakeHost()
      expect(() =>
        runStep(host, {
          stepId: 'stp_1',
          command: 'rm -rf /opt/old-cache',
          expectation: null,
          timeoutMs: 10_000,
        }),
      ).toThrow(NeedsConfirmation)
    })

    it('带上命中的模式，便于 UI 说明原因', () => {
      const host = new FakeHost()
      try {
        runStep(host, {
          stepId: 'stp_1',
          command: 'rm -rf /data',
          expectation: null,
          timeoutMs: 10_000,
        })
        expect.unreachable('应当抛错')
      } catch (e) {
        expect(e).toBeInstanceOf(NeedsConfirmation)
        expect((e as NeedsConfirmation).matched).toContain('rm -rf')
      }
    })

    it('确认后正常执行', async () => {
      const host = new FakeHost()
      host.setScript([{ exitCode: 0 }])

      const handle = runStep(host, {
        stepId: 'stp_1',
        command: 'rm -rf /opt/old-cache',
        expectation: null,
        timeoutMs: 10_000,
        confirmed: true,
      })

      const outcome = await handle.outcome
      expect(outcome.verdict).toBe('pass')
      expect(outcome.danger).toBe('destructive')
    })

    it('caution 级别不需要确认', async () => {
      const host = new FakeHost()
      host.setScript([{ exitCode: 0 }])

      const handle = runStep(host, {
        stepId: 'stp_1',
        command: 'git reset --hard HEAD~1',
        expectation: null,
        timeoutMs: 10_000,
      })

      const outcome = await handle.outcome
      expect(outcome.danger).toBe('caution')
      expect(outcome.verdict).toBe('pass')
    })
  })

  describe('脱敏', () => {
    it('落库用的输出已脱敏', async () => {
      const host = new FakeHost()
      host.setScript([{ stdout: 'using key sk-abcdefghijklmnopqrst\n', exitCode: 0 }])

      const handle = runStep(host, {
        stepId: 'stp_1',
        command: 'echo $OPENAI_API_KEY',
        expectation: null,
        timeoutMs: 10_000,
      })

      const outcome = await handle.outcome
      expect(outcome.redactedStdout).not.toContain('sk-abcdefghijklmnopqrst')
      expect(outcome.redactionHits.length).toBeGreaterThan(0)
      // 原始结果保留在内存里供判定用，但不该被持久化
      expect(outcome.result.stdout).toContain('sk-abcdefghijklmnopqrst')
    })

    it('流式推送也脱敏', async () => {
      const host = new FakeHost()
      host.setScript([{ chunks: ['token=hunter2secret\n'], exitCode: 0 }])

      const seen: string[] = []
      const handle = runStep(host, {
        stepId: 'stp_1',
        command: 'cat config',
        expectation: null,
        timeoutMs: 10_000,
      })
      handle.onChunk((c) => seen.push(c.text))

      await handle.outcome
      expect(seen.join('')).not.toContain('hunter2secret')
    })

    it('预期判定基于原文，不受脱敏影响', async () => {
      const host = new FakeHost()
      // 输出里既有凭据又有预期要匹配的文本
      host.setScript([{ stdout: 'key=sk-aaaaaaaaaaaaaaaaaa\nStarted server\n', exitCode: 0 }])

      const handle = runStep(host, {
        stepId: 'stp_1',
        command: 'start.sh',
        expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
        timeoutMs: 10_000,
      })

      const outcome = await handle.outcome
      expect(outcome.verdict).toBe('pass')
      expect(outcome.redactedStdout).not.toContain('sk-aaaaaaaaaaaaaaaaaa')
    })
  })

  it('可以取消', async () => {
    const host = new FakeHost()
    host.setScript([{ exitCode: 0 }])

    const handle = runStep(host, {
      stepId: 'stp_1',
      command: 'sleep 999',
      expectation: null,
      timeoutMs: 600_000,
    })

    expect(handle.cancel()).toBe(true)
    const outcome = await handle.outcome
    expect(outcome.result.timedOut).toBe(true)
  })

  it('把 cwd 和 env 透传给宿主', async () => {
    const host = new FakeHost()
    host.setScript([{ exitCode: 0 }])

    const handle = runStep(host, {
      stepId: 'stp_1',
      command: 'pwd',
      expectation: null,
      timeoutMs: 10_000,
      cwd: '/workspace',
      env: { CUDA_VISIBLE_DEVICES: '0,1' },
    })
    await handle.outcome

    expect(host.calls[0]?.cwd).toBe('/workspace')
    expect(host.calls[0]?.env).toEqual({ CUDA_VISIBLE_DEVICES: '0,1' })
  })
})
