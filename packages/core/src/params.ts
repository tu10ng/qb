/**
 * 命令模板与参数（纯函数）。
 *
 * 模板里写 {{PREFILL_IP}}，参数表给它取值；复制和运行用的都是渲染后
 * 的命令。规则（方案 §4）：
 * - 只替换已声明的参数；模板里出现未声明的名字要报出来
 * - 与 docker/kubectl 的 Go 模板 {{.X}} 天然不冲突（这里要求全大写）
 */

import type { Param } from './schema.ts'

/** 模板里的参数引用。全大写下划线，不匹配 {{.Field}} 这种 Go 模板。 */
export const PARAM_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

/** 一段模板文本里引用到的全部参数名（按出现顺序，去重）。 */
export function paramRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PARAM_RE)) {
    if (!out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

export interface Rendered {
  text: string
  /** 引用了但参数表里没有（或值为空）的名字——这一步跑不起来。 */
  missing: string[]
  /** 引用了、但不在参数表里的名字——模板写错了，要提示。 */
  undeclared: string[]
}

/** 按参数表渲染模板。没有值的引用原样保留（能看出缺的是哪个）。 */
export function render(text: string, params: Param[]): Rendered {
  const byName = new Map(params.map((p) => [p.name, p]))
  const missing: string[] = []
  const undeclared: string[] = []

  const out = text.replace(PARAM_RE, (whole, name: string) => {
    const p = byName.get(name)
    if (p === undefined) {
      if (!undeclared.includes(name)) undeclared.push(name)
      return whole
    }
    if (p.value === '') {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return p.value
  })

  return { text: out, missing, undeclared }
}

/** 渲染一条命令；缺值时附上名字列表（调用方据此置灰运行按钮）。 */
export function renderCommand(template: string, params: Param[]): Rendered {
  return render(template, params)
}

// ── 提取建议 ─────────────────────────────────────────────────

export type LiteralKind = 'ip' | 'port' | 'path' | 'host'

export interface LiteralSuggestion {
  value: string
  count: number
  kind: LiteralKind
  /** 建议的参数名，如 PREFILL_IP。 */
  suggestedName: string
}

const PATTERNS: Array<{ kind: LiteralKind; re: RegExp; nameHint: (v: string) => string; minCount: number }> = [
  {
    kind: 'ip',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    nameHint: (v) => `IP_${v.replaceAll('.', '_')}`,
    minCount: 1,
  },
  {
    kind: 'host',
    re: /\b(?:gpu|node|server|host|worker)-?\d{1,3}\b/gi,
    nameHint: (v) => v.toUpperCase().replaceAll('-', '_'),
    minCount: 2,
  },
  {
    // 4–5 位端口（10001 这种 5 位的也要认出来）
    kind: 'port',
    re: /(?<![=\w])((?:8|9|3|1)\d{3,4})(?![\w])/g,
    nameHint: (v) => `PORT_${v}`,
    minCount: 2,
  },
  {
    kind: 'path',
    re: /\B\/(?:data|home|root|opt|mnt|srv|models|workspace)\/[\w./-]+/g,
    nameHint: (v) => `PATH_${v.replaceAll('/', '_').replace(/^_+|_+$/g, '').toUpperCase()}`,
    minCount: 2,
  },
]

/**
 * 扫一组文本里重复出现的字面值，建议提成参数。
 *
 * "把 10.0.3.17 提成参数？（出现 4 次）"——重复出现才值得参数化；
 * IP 单独放行（minCount 1）：集群里 IP 几乎必然要换环境。
 */
export function literalSuggestions(texts: string[]): LiteralSuggestion[] {
  const out: LiteralSuggestion[] = []
  for (const { kind, re, nameHint, minCount } of PATTERNS) {
    const counts = new Map<string, number>()
    for (const text of texts) {
      for (const m of text.matchAll(re)) {
        const v = m[0]!
        counts.set(v, (counts.get(v) ?? 0) + 1)
      }
    }
    for (const [value, count] of counts) {
      if (count >= minCount) out.push({ value, count, kind, suggestedName: nameHint(value) })
    }
  }
  // 出现次数多的排前面；同值多形态（既是 IP 又被 host 规则扫到）按值去重
  out.sort((a, b) => b.count - a.count)
  const seen = new Set<string>()
  return out.filter((s) => (seen.has(s.value) ? false : (seen.add(s.value), true)))
}

// ── 同值联动 ─────────────────────────────────────────────────

export interface SameValueGroup {
  value: string
  names: string[]
}

/**
 * 值相同的参数分到一组。改其中一个时提示"这几个原来也是这个值，一起改？"。
 * 实测同一个字面值常被拆成多个参数（PREFILL_IP / PROXY_IP / BENCH_HOST）。
 */
export function sameValueGroups(params: Param[]): SameValueGroup[] {
  const byValue = new Map<string, string[]>()
  for (const p of params) {
    if (p.value === '') continue
    const list = byValue.get(p.value) ?? []
    list.push(p.name)
    byValue.set(p.value, list)
  }
  return [...byValue.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([value, names]) => ({ value, names }))
}

/** 参数表里还有谁与这个值相同（排除自己）。 */
export function othersWithValue(params: Param[], name: string, value: string): string[] {
  return params.filter((p) => p.name !== name && p.value === value && value !== '').map((p) => p.name)
}

/** 把任意字符串转成合法参数名（大写下划线）。 */
export function toParamName(hint: string): string {
  const cleaned = hint
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return cleaned === '' ? 'PARAM' : cleaned
}
