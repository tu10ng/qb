/**
 * 按行对比两段文本（纯函数）：回显"这次和上次、和参考回显、和别的任务里
 * 同一步"哪里不一样。经典 LCS，按行比；行数太多时只比首尾之外的中段并
 * 截断，界面上不至于卡死。
 */

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string }

/** 超过这个行数（两边之积）就不做完整 LCS，退化成"前面相同 + 中段整体替换 + 后面相同"。 */
const MAX_CELLS = 4_000_000

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')

  // 首尾相同的部分先剥掉：日志通常开头结尾一样，中间有几行变了
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const out: DiffOp[] = a.slice(0, head).map((text) => ({ kind: 'same', text }))
  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) out.push({ kind: 'del', text })
    for (const text of midB) out.push({ kind: 'add', text })
  } else {
    out.push(...lcsDiff(midA, midB))
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text })
  return out
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // len[i][j] = a[i..] 与 b[j..] 的 LCS 长度，一维数组存
  const len = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number): number => len[i * (m + 1) + j]!
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: a[i++]! })
    } else {
      out.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return out
}

/** 有几行不一样（增 + 删）。 */
export function diffCount(ops: DiffOp[]): number {
  return ops.filter((o) => o.kind !== 'same').length
}
