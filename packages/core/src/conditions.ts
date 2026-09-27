/**
 * 坑的结构化条件（M9）。
 *
 * 捕获卡片里的条件是一句可读的话，形如：
 *   DECODE_HOST == gpu-18 AND 环境.GPU contains H800
 * 匹配是确定性的——参数表与环境事实代入，全项成立才成立，不叫模型。
 * 解析不了、或引用的名字拿不到值 → null（无法判定），界面按第二层折叠。
 * 自由文本条件（如导入时生成的「步骤「启动 decode」」）也走这条 null 路径。
 */

import type { EnvironmentFacts, Param } from './schema.ts'

export type CondOp = '==' | '!=' | 'contains'

export interface CondTerm {
  /** 参数名（大写下划线）或环境事实名（GPU / OS / SHELL / ARCH / CUDA，小写比对）。 */
  name: string
  op: CondOp
  value: string
  isEnv: boolean
}

export interface ParsedCondition {
  terms: CondTerm[]
}

// 一项：参数或环境事实 + 运算符 + 值。中文「包含」与 contains 等价，
// 捕获卡片预填用中文，人手写用哪个都行。
const TERM_RE = /^(环境\.([A-Za-z]+)|([A-Z][A-Z0-9_]*))\s*(==|!=|contains|包含)\s*(.+)$/

/** 解析条件；解析不了返回 null（显示层照常展示原文）。 */
export function parseCondition(text: string | null | undefined): ParsedCondition | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const terms: CondTerm[] = []
  for (const raw of text.split(/\s+AND\s+/i)) {
    const m = TERM_RE.exec(raw.trim())
    if (m === null) return null
    terms.push({
      name: (m[2] ?? m[3]!).toLowerCase(),
      op: m[4] === '包含' ? 'contains' : (m[4] as CondOp),
      value: m[5]!.trim(),
      isEnv: m[2] !== undefined,
    })
  }
  return terms.length > 0 ? { terms } : null
}

/**
 * 条件在当前参数与环境下的判定：true 成立（第一层）、false 不成立（第二层）、
 * null 无法判定（第二层，但不算"帮不上"）。无条件 → true（血缘锚定本身就算匹配）。
 */
export function matchCondition(cond: ParsedCondition | null, params: Param[], env?: EnvironmentFacts | null): boolean | null {
  if (cond === null) return true
  const byName = new Map(params.map((p) => [p.name, p]))
  for (const t of cond.terms) {
    if (t.isEnv) {
      if (env === null || env === undefined) return null
      const fact = envFactsText(env)[t.name]
      if (fact === undefined) return null
      if (!cmp(fact, t)) return false
    } else {
      const p = byName.get(t.name.toUpperCase())
      if (p === undefined || p.value === '') return null
      if (!cmp(p.value, t)) return false
    }
  }
  return true
}

function cmp(actual: string, t: CondTerm): boolean {
  switch (t.op) {
    case '==':
      return actual === t.value
    case '!=':
      return actual !== t.value
    case 'contains':
      return actual.toLowerCase().includes(t.value.toLowerCase())
  }
}

function envFactsText(env: EnvironmentFacts): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['os', 'shell', 'arch', 'gpu', 'cuda'] as const) {
    const v = env[key]
    if (typeof v === 'string' && v !== '') out[key] = v
  }
  return out
}

/** 把一组参数渲染成条件文本（捕获卡片预填用）：NAME == value AND … */
export function conditionFromParams(params: Param[], names: string[]): string | null {
  const byName = new Map(params.map((p) => [p.name, p]))
  const terms = names
    .map((n) => byName.get(n))
    .filter((p): p is Param => p !== undefined && p.value !== '' && !p.secret)
    .map((p) => `${p.name} == ${p.value}`)
  return terms.length > 0 ? terms.join(' AND ') : null
}
