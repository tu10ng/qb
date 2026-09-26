import { describe, expect, it } from 'vitest'
import { orderKeyBetween, orderKeySequence } from '../src/order-key.ts'

describe('orderKeyBetween', () => {
  it('空列表生成中点键', () => {
    expect(orderKeyBetween(null, null)).toBe('V')
  })

  it('追加到末尾时递增', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyBetween(a, null)
    const c = orderKeyBetween(b, null)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it('插入到开头时递减', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyBetween(null, a)
    const c = orderKeyBetween(null, b)
    expect(b < a).toBe(true)
    expect(c < b).toBe(true)
  })

  it('两键之间插入', () => {
    const a = orderKeyBetween(null, null)
    const b = orderKeyBetween(a, null)
    const mid = orderKeyBetween(a, b)
    expect(a < mid).toBe(true)
    expect(mid < b).toBe(true)
  })

  it('a >= b 时抛错', () => {
    expect(() => orderKeyBetween('V', 'V')).toThrow()
    expect(() => orderKeyBetween('W', 'V')).toThrow()
  })

  it('生成的键不以 0 结尾', () => {
    // 尾零会让 "V" 与 "V0" 之间无法插入
    let prev: string | null = null
    for (let i = 0; i < 50; i++) {
      const k: string = orderKeyBetween(prev, null)
      expect(k.endsWith('0')).toBe(false)
      prev = k
    }
  })

  it('反复在同一处插入仍保持有序（最坏情况）', () => {
    let lo = orderKeyBetween(null, null)
    const hi = orderKeyBetween(lo, null)
    // 每次都往最左边的缝隙里插，键会变长但必须始终有序
    for (let i = 0; i < 100; i++) {
      const mid = orderKeyBetween(lo, hi)
      expect(lo < mid).toBe(true)
      expect(mid < hi).toBe(true)
      lo = mid
    }
  })

  it('反复往最前面插入', () => {
    let first = orderKeyBetween(null, null)
    for (let i = 0; i < 100; i++) {
      const next = orderKeyBetween(null, first)
      expect(next < first).toBe(true)
      first = next
    }
  })

  it('反复往最后面追加', () => {
    let last = orderKeyBetween(null, null)
    for (let i = 0; i < 100; i++) {
      const next = orderKeyBetween(last, null)
      expect(last < next).toBe(true)
      last = next
    }
  })

  it('随机重排后顺序始终自洽', () => {
    // 模拟真实的拖拽：随机挑一个位置插入，验证整体有序性不被破坏
    let keys = orderKeySequence(5)
    for (let round = 0; round < 200; round++) {
      const pos = Math.floor(Math.random() * (keys.length + 1))
      const before = pos === 0 ? null : keys[pos - 1]!
      const after = pos === keys.length ? null : keys[pos]!
      const k = orderKeyBetween(before, after)
      keys = [...keys.slice(0, pos), k, ...keys.slice(pos)]

      const sorted = [...keys].sort()
      expect(keys).toEqual(sorted)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

describe('orderKeySequence', () => {
  it('生成递增序列', () => {
    const keys = orderKeySequence(10)
    expect(keys).toHaveLength(10)
    expect([...keys].sort()).toEqual(keys)
  })

  it('可以接在已有键之后', () => {
    const [first] = orderKeySequence(1)
    const rest = orderKeySequence(3, first!)
    expect(rest.every((k) => k > first!)).toBe(true)
    expect([...rest].sort()).toEqual(rest)
  })

  it('count 为 0 时返回空数组', () => {
    expect(orderKeySequence(0)).toEqual([])
  })
})
