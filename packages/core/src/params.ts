/**
 * 命令模板与参数（纯函数）。
 *
 * 模板里写 {{PREFILL_IP}} 或 {{机器195.密码}}，参数表给它取值；复制和运行
 * 用的都是渲染后的命令。规则（方案 §4）：
 * - 只替换已声明的参数；模板里出现未声明的名字要报出来
 * - 名字可以用中文；与 docker/kubectl 的 Go 模板 {{.X}}、{{json .}} 不冲突
 *   （那些以点开头或带空格）
 * - 字段：一个参数可以带一组相关取值（一台机器的 IP / 用户 / 密码），
 *   {{名字}} 是主值，{{名字.字段}} 是某个字段
 */

import { FIELD_KEY_SRC, PARAM_NAME_RE, PARAM_NAME_SRC, type Param, type ParamField } from './schema.ts'

/**
 * 模板里的参数引用：{{名字}} 或 {{名字.字段}}。m[1] 是名字，m[2] 是字段。
 * 不匹配 {{.Field}}（Go 模板）、{{ name }}（带空格）、{{name}}（纯小写，多半是
 * jinja/mustache）。
 */
export const PARAM_RE = new RegExp(String.raw`\{\{(${PARAM_NAME_SRC})(?:\.(${FIELD_KEY_SRC}))?\}\}`, 'gu')

/** 一段模板文本里引用到的全部参数名（按出现顺序，去重；只取名字，不带字段）。 */
export function paramRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PARAM_RE)) {
    if (!out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

/** 模板切成的一段：普通文字，或一处参数引用。界面据此画下划线、给 secret 打码。 */
export type TemplateSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'param'
      /** 原样的引用文字，如 {{机器195.密码}}。 */
      raw: string
      /** 名字或 名字.字段。 */
      ref: string
      name: string
      field: string | null
      /** 渲染出来的值；缺值或未声明时为 null。 */
      value: string | null
      missing: boolean
      undeclared: boolean
      secret: boolean
    }

/** 参数的某个字段（主值的标签也算，如 {{机器195.IP}}）。 */
function fieldOf(p: Param, key: string): ParamField | null {
  const f = p.fields?.find((x) => x.key === key)
  if (f !== undefined) return f
  if (p.valueLabel !== undefined && p.valueLabel === key) return { key, value: p.value, secret: p.secret }
  return null
}

/** 把模板切成文字段与参数段。 */
export function segmentTemplate(text: string, params: Param[]): TemplateSegment[] {
  const byName = new Map(params.map((p) => [p.name, p]))
  const out: TemplateSegment[] = []
  let last = 0
  for (const m of text.matchAll(PARAM_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) })
    const name = m[1]!
    const field = m[2] ?? null
    const ref = field === null ? name : `${name}.${field}`
    const p = byName.get(name)
    const f = p === undefined || field === null ? null : fieldOf(p, field)
    if (p === undefined || (field !== null && f === null)) {
      out.push({ kind: 'param', raw: m[0], ref, name, field, value: null, missing: false, undeclared: true, secret: false })
    } else {
      const value = f !== null ? f.value : p.value
      const secret = f !== null ? f.secret : p.secret
      out.push({ kind: 'param', raw: m[0], ref, name, field, value: value === '' ? null : value, missing: value === '', undeclared: false, secret })
    }
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export interface Rendered {
  text: string
  /** 引用了但没有值的（名字或 名字.字段）——这一步跑不起来。 */
  missing: string[]
  /** 引用了、但参数表里没有的——模板写错了，要提示。 */
  undeclared: string[]
}

/** 按参数表渲染模板。没有值的引用原样保留（能看出缺的是哪个）。 */
export function render(text: string, params: Param[]): Rendered {
  const missing: string[] = []
  const undeclared: string[] = []
  let out = ''
  for (const s of segmentTemplate(text, params)) {
    if (s.kind === 'text') {
      out += s.text
      continue
    }
    if (s.undeclared) {
      if (!undeclared.includes(s.ref)) undeclared.push(s.ref)
      out += s.raw
    } else if (s.value === null) {
      if (!missing.includes(s.ref)) missing.push(s.ref)
      out += s.raw
    } else {
      out += s.value
    }
  }
  return { text: out, missing, undeclared }
}

/** 渲染一条命令；缺值时附上名字列表（调用方据此置灰运行按钮）。 */
export function renderCommand(template: string, params: Param[]): Rendered {
  return render(template, params)
}

/** 只取第 from–to 行（从 1 起，含两端）：运行/复制选中的几行。 */
export function pickLines(text: string, from: number, to: number): string {
  const lines = text.split(/\r?\n/)
  const a = Math.max(1, Math.min(from, to))
  const b = Math.min(lines.length, Math.max(from, to))
  return lines.slice(a - 1, b).join('\n')
}

// ── secret ───────────────────────────────────────────────────

/** 参数表里所有 secret 的值（参数本身或字段）。太短的不算——打码会误伤。 */
export function secretValues(params: Param[]): string[] {
  const out = new Set<string>()
  for (const p of params) {
    if (p.secret && p.value.length >= 3) out.add(p.value)
    for (const f of p.fields ?? []) if (f.secret && f.value.length >= 3) out.add(f.value)
  }
  // 长的先换：一个值是另一个值的子串时，先换长的才不会漏半截
  return [...out].sort((a, b) => b.length - a.length)
}

/** 把 secret 的值换成 ***：证据落库、上传、复制去 IM 之前都过一遍。 */
export function redactSecrets(text: string, params: Param[]): { text: string; hits: number } {
  let out = text
  let hits = 0
  for (const v of secretValues(params)) {
    if (!out.includes(v)) continue
    const parts = out.split(v)
    hits += parts.length - 1
    out = parts.join('***')
  }
  return { text: out, hits }
}

// ── 机器：贴进来的 "IP 用户 密码" 一行 ─────────────────────────

export interface MachineLine {
  host: string
  port: string | null
  user: string | null
  password: string | null
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const HOSTLIKE = /^(?=.*[A-Za-z])[A-Za-z0-9][\w.-]*$/

function hostPort(token: string): { host: string; port: string | null } | null {
  const m = /^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/.exec(token)
  if (m === null) return null
  const host = m[1]!
  if (IPV4.test(host) || (HOSTLIKE.test(host) && (host.includes('.') || /\d/.test(host)))) {
    return { host, port: m[2] ?? null }
  }
  return null
}

/**
 * 认一行机器信息："10.9.8.195  root  密码"、"root@10.0.3.17 密码"、
 * "IP: x 用户: y 密码: z"、"ssh root@host -p 2222"。认不出主机返回 null。
 */
export function parseMachineLine(line: string): MachineLine | null {
  const text = line.replace(/　/g, ' ').replace(/：/g, ':').trim()
  if (text === '') return null

  // 带标签的写法
  const label = (re: RegExp): string | null => re.exec(text)?.[1] ?? null
  const lHost = label(/(?:^|\s)(?:ip|host|地址|主机|机器)\s*[:=]\s*(\S+)/i)
  const lUser = label(/(?:^|\s)(?:user(?:name)?|用户名?|账号|帐号)\s*[:=]\s*(\S+)/i)
  const lPass = label(/(?:^|\s)(?:password|passwd|pwd|密码|口令)\s*[:=]\s*(\S+)/i)
  const lPort = label(/(?:^|\s)(?:port|端口)\s*[:=]\s*(\d{1,5})/i)
  if (lHost !== null) {
    const hp = hostPort(lHost)
    if (hp !== null) return { host: hp.host, port: lPort ?? hp.port, user: lUser, password: lPass }
  }

  const tokens = text
    .replace(/^ssh\s+/, '')
    .split(/[\s,，;；|]+/)
    .filter((t) => t !== '')
  let host: string | null = null
  let port: string | null = null
  let user: string | null = null
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-p' && /^\d{1,5}$/.test(tokens[i + 1] ?? '')) {
      port = tokens[++i]!
      continue
    }
    if (host === null) {
      const at = /^([^@\s]+)@(.+)$/.exec(t)
      const hp = hostPort(at !== null ? at[2]! : t)
      if (hp !== null) {
        host = hp.host
        port = hp.port ?? port
        if (at !== null) user = at[1]!
        continue
      }
      // 主机前面的东西（序号、机器名）不算用户名密码
      continue
    }
    if (port === null && /^\d{2,5}$/.test(t) && rest.length === 0 && user === null) {
      port = t
      continue
    }
    rest.push(t)
  }
  if (host === null) return null
  if (user === null && rest.length > 0) user = rest.shift()!
  const password = rest.length > 0 ? rest.join(' ') : null
  return { host, port, user, password }
}

/** 贴进来的一段里能认出的所有机器（每行一台）。 */
export function parseMachines(text: string): MachineLine[] {
  return text
    .split(/\r?\n/)
    .map(parseMachineLine)
    .filter((m): m is MachineLine => m !== null)
}

/** 一台机器 → 一个带字段的参数（主值是 IP，密码是 secret）。 */
export function machineParam(m: MachineLine, name: string): Param {
  const fields: ParamField[] = []
  if (m.user !== null) fields.push({ key: '用户', value: m.user, secret: false })
  if (m.password !== null) fields.push({ key: '密码', value: m.password, secret: true })
  if (m.port !== null) fields.push({ key: '端口', value: m.port, secret: false })
  return { name, value: m.host, valueLabel: 'IP', source: 'mine', secret: false, fields }
}

/** 机器参数的默认名字：机器 + IP 末段（机器195）；主机名就用主机名。 */
export function machineName(host: string, taken: ReadonlySet<string>): string {
  const base = IPV4.test(host) ? `机器${host.split('.').pop()}` : toParamName(host)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  return name
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
    // 4–5 位端口（10001 这种 5 位的也要认出来）。
    // 前后不能贴着字母/数字/点/横杠；前面是 'n '（ulimit -n 1024）或
    // '-n'（rlimit）的不算端口。仍会漏认少数写法——提取建议只是建议。
    kind: 'port',
    re: /(?<![\w.\-])(?<!n\s)((?:8|9|3|1)\d{3,4})(?![\w.])/g,
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

/**
 * 把任意字符串转成合法参数名：非字母数字下划线的换成下划线，中文照留；
 * 纯英文的转大写（DECODE_HOST 这种约定），以数字开头的前面补 P_。
 */
export function toParamName(hint: string): string {
  let cleaned = hint
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  if (cleaned === '') return 'PARAM'
  if (/^[\x00-\x7f]*$/.test(cleaned)) cleaned = cleaned.toUpperCase()
  return /^\p{N}/u.test(cleaned) ? `P_${cleaned}` : cleaned
}

/**
 * 模型或人给的参数名归一（导入、差异、起草都过它）：空格和横杠换成下划线，
 * 纯英文转大写；归一后仍不合法（数字开头、只剩符号）返回 null。
 */
export function normalizeParamName(raw: string): string | null {
  let name = raw.trim().replace(/[\s\-.]+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '')
  if (/^[\x00-\x7f]*$/.test(name)) name = name.toUpperCase()
  return PARAM_NAME_RE.test(name) ? name : null
}
