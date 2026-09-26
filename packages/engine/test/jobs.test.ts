import { describe, expect, it } from 'vitest'
import { Jobs, type Job } from '../src/web/jobs.ts'

/** 用受控的 Promise 手动推进任务，验证去重与排队语义。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function untilDone(job: Job): Promise<Job> {
  const deadline = Date.now() + 1000
  while (job.status === 'running') {
    if (Date.now() > deadline) throw new Error('job 没在期限内完成')
    await new Promise((r) => setTimeout(r, 5))
  }
  return job
}

describe('Jobs', () => {
  it('默认去重：同类同 subject 只跑一个，existing=true', async () => {
    const jobs = new Jobs({ onUpdate: () => {} })
    const gate = deferred()
    const a = jobs.start('draft', 't1', () => gate.promise)
    const b = jobs.start('draft', 't1', () => Promise.reject(new Error('不该跑第二个')))

    expect(a.job.id).toBe(b.job.id)
    expect(b.existing).toBe(true)
    gate.resolve()
    expect((await untilDone(a.job)).status).toBe('done')
  })

  it('排队：前一个做完后后一个接着跑，两个都有结果', async () => {
    const jobs = new Jobs({ onUpdate: () => {} })
    const order: string[] = []
    const gate1 = deferred()

    const first = jobs.start('judge', 'stp1', async () => {
      await gate1.promise
      order.push('first')
    })
    // 第一张还没看完
    const second = jobs.start(
      'judge',
      'stp1',
      async () => {
        order.push('second')
      },
      { queue: true },
    )

    expect(first.existing).toBe(false)
    expect(second.existing).toBe(false)

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([]) // second 在排队，没偷跑

    gate1.resolve()
    await untilDone(second.job)
    expect(order).toEqual(['first', 'second'])
  })

  it('前一个失败不拖垮排队的下一个', async () => {
    const jobs = new Jobs({ onUpdate: () => {} })
    const gate = deferred()
    const first = jobs.start('judge', 'stp1', async () => {
      await gate.promise
      throw new Error('第一张看不了')
    })
    const second = jobs.start('judge', 'stp1', async () => 'ok', { queue: true })

    gate.resolve()
    expect((await untilDone(first.job)).status).toBe('failed')
    expect((await untilDone(second.job)).status).toBe('done')
    expect(second.job.result).toBe('ok')
  })

  it('不同 subject 互不排队', async () => {
    const jobs = new Jobs({ onUpdate: () => {} })
    const gate = deferred()
    const order: string[] = []
    const a = jobs.start(
      'judge',
      'stp1',
      async () => {
        await gate.promise
        order.push('a')
      },
      { queue: true },
    )
    const b = jobs.start(
      'judge',
      'stp2',
      async () => {
        order.push('b')
      },
      { queue: true },
    )

    await untilDone(b.job)
    expect(order).toEqual(['b']) // b 不等 a
    gate.resolve()
    await untilDone(a.job)
    expect(order).toEqual(['b', 'a'])
  })
})
