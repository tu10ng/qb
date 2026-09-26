/**
 * 分数索引（fractional indexing）。
 *
 * 拖拽重排时只改被移动的那一行，不重写兄弟节点——这让重排是 O(1) 写入，
 * 也让并发编辑不会互相覆盖顺序。
 *
 * 键是 base62 字符串，按字典序比较，语义上是小数点后的数字序列
 * （"V" 读作 0.V）。两个不同的键之间总能再插入一个键。
 *
 * 不变量：键非空且不以 '0' 结尾。'0' 结尾会让 "V" 与 "V0" 之间无法
 * 表示（二者数值相等），所有生成路径都维持这一点。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length // 62

/** 第 i 位的数值；超出长度按 0 计（小数补零，不影响数值）。 */
function digitAt(key: string, i: number): number {
  if (i >= key.length) return 0
  const c = key[i]!
  const v = DIGITS.indexOf(c)
  if (v < 0) throw new Error(`orderKey 含非法字符: ${JSON.stringify(c)}`)
  return v
}

/** 去掉尾部的 '0'，维持不变量。 */
function trimTrailingZeros(digits: number[]): number[] {
  const out = [...digits]
  while (out.length > 0 && out[out.length - 1] === 0) out.pop()
  return out
}

function toKey(digits: number[]): string {
  const trimmed = trimTrailingZeros(digits)
  if (trimmed.length === 0) {
    throw new Error('orderKey 生成结果为空（数值 0 不是合法键）')
  }
  return trimmed.map((d) => DIGITS[d]!).join('')
}

/**
 * 计算两个小数的中点，逐位处理借位。
 *
 * a 与 b 都表示为数位数组（小数点后），要求 a < b。
 * 返回严格位于二者之间的数位数组。
 */
function midpoint(a: number[], b: number[] | null): number[] {
  const out: number[] = []
  let i = 0

  // 逐位复制相同前缀
  while (true) {
    const da = i < a.length ? a[i]! : 0
    const db = b === null ? BASE : i < b.length ? b[i]! : 0
    if (da !== db) break
    out.push(da)
    i++
  }

  const da = i < a.length ? a[i]! : 0
  const db = b === null ? BASE : i < b.length ? b[i]! : 0

  // 此时 da < db。若中间有整数空隙，直接取中点即可收尾。
  if (db - da > 1) {
    out.push(da + Math.floor((db - da) / 2))
    return out
  }

  // da 与 db 相邻：结果必须以 da 开头，然后在 a 的剩余部分与
  // "无上界"之间找中点——因为任何以 da 开头且大于 a 剩余部分的数
  // 都小于 b（b 在这一位就更大）。
  out.push(da)
  const aRest = a.slice(i + 1)
  return [...out, ...midpoint(aRest, null)]
}

/**
 * 生成 a 与 b 之间的键。
 *
 * @param a 前一个键，null 表示"排在最前"
 * @param b 后一个键，null 表示"排在最后"
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween 要求 a < b，实际 a=${a} b=${b}`)
  }

  const aDigits = a === null ? [] : [...a].map((_, i) => digitAt(a, i))
  const bDigits = b === null ? null : [...b].map((_, i) => digitAt(b, i))

  return toKey(midpoint(aDigits, bDigits))
}

/** 为一批新节点生成连续递增的键。 */
export function orderKeySequence(count: number, after: string | null = null): string[] {
  const keys: string[] = []
  let prev = after
  for (let i = 0; i < count; i++) {
    const key = orderKeyBetween(prev, null)
    keys.push(key)
    prev = key
  }
  return keys
}
