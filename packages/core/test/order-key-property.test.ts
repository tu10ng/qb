import { describe, expect, it } from 'vitest'
import { orderKeyBetween, orderKeySequence } from '../src/order-key.ts'

/**
 * 属性测试：随机重排。
 *
 * 这个测试在开发期抓到两个真实缺陷（trim 尾零导致新键等于左邻居；
 * 相邻位细分导致新键等于右邻居），保留为回归防线。
 */
describe('orderKey 属性：随机插入永远保持严格有序且不重复', () => {
  it('2000 轮随机插入', () => {
    let keys = orderKeySequence(5)

    for (let round = 0; round < 2000; round++) {
      const pos = Math.floor(Math.random() * (keys.length + 1))
      const before = pos === 0 ? null : keys[pos - 1]!
      const after = pos === keys.length ? null : keys[pos]!

      const k = orderKeyBetween(before, after)

      if (before !== null) {
        expect(k > before, `第 ${round} 轮: ${k} 应 > ${before}`).toBe(true)
      }
      if (after !== null) {
        expect(k < after, `第 ${round} 轮: ${k} 应 < ${after}`).toBe(true)
      }
      expect(k.endsWith('0'), `第 ${round} 轮: ${k} 不应以 0 结尾`).toBe(false)

      keys = [...keys.slice(0, pos), k, ...keys.slice(pos)]
    }

    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('键长度增长可控', () => {
    // 始终往同一条缝里插是最坏情况，键会变长但不该爆炸
    let lo = orderKeyBetween(null, null)
    const hi = orderKeyBetween(lo, null)
    for (let i = 0; i < 200; i++) {
      lo = orderKeyBetween(lo, hi)
    }
    // 每次细分最多加一位，200 次插入远不到 200 位
    expect(lo.length).toBeLessThan(220)
  })
})
