/**
 * 坑的结构化条件（M9）。
 *
 * 捕获卡片里的条件是一句可读的话，形如：
 *   DECODE_HOST == gpu-18 AND 环境.GPU contains H800
 * 参数名可以是中文，也可以带字段（机器195.用户 == root）。
 * 匹配是确定性的——参数表与环境事实代入，全项成立才成立，不叫模型。
 * 解析不了、或引用的名字拿不到值 → null（无法判定），界面按第二层折叠。
 * 自由文本条件（如导入时生成的「步骤「启动 decode」」）也走这条 null 路径。
 */

import { FIELD_KEY_SRC, PARAM_NAME_SRC, type EnvironmentFacts, type Param } from './schema.ts'

export type CondOp = '==' | '!=' | 'contains'

export interface CondTerm {
  /** 参数名（原样，区分大小写，可带 .字段）或环境事实名（gpu / os / shell / arch / cuda，小写）。 */
  name: string
  op: CondOp
  value: string
  isEnv: boolean
}

export interface ParsedCondition {
  terms: CondTerm[]
}

// 一项：参数或环境事实 + 运算符 + 值。中文「包含」与 contains 等价，
// 捕获卡片预填用中文，人手写用哪个都行。== / != 两边空格可省；包含/contains
// 要空格隔开（中文名里"包含"两个字也是字母，不隔开分不清）。
const TERM_RE = new RegExp(
  String.raw`^(环境\.([A-Za-z]+)|(${PARAM_NAME_SRC}(?:\.${FIELD_KEY_SRC})?))(?:\s*(==|!=)\s*|\s+(contains|包含)\s+)(.+)$`,
  'u',
)

/** 解析条件；解析不了返回 null（显示层照常展示原文）。 */
export function parseCondition(text: string | null | undefined): ParsedCondition | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const terms: CondTerm[] = []
  for (const raw of text.split(/\s+AND\s+/i)) {
    const m = TERM_RE.exec(raw.trim())
    if (m === null) return null
    const isEnv = m[2] !== undefined
    const name = isEnv ? m[2]!.toLowerCase() : m[3]!
    const op = m[4] ?? (m[5] === '包含' ? 'contains' : m[5])
    terms.push({ name, op: op as CondOp, value: m[6]!.trim(), isEnv })
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
      const [name, field] = t.name.split('.') as [string, string | undefined]
      const p = byName.get(name)
      if (p === undefined) return null
      const value = field === undefined ? p.value : field === p.valueLabel ? p.value : p.fields?.find((f) => f.key === field)?.value
      if (value === undefined || value === '') return null
      if (!cmp(value, t)) return false
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
