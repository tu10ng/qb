/**
 * 把 markdown / org-mode 文档确定性地导入成 runbook 的块树（纯函数，不叫模型）。
 *
 * 映射：
 * - 标题（# / *）→ 章节，层级照原文嵌套
 * - 段落、列表、表格、图片、链接 → 文字块（markdown）
 * - 代码块：shell 系的按内容分成"命令"（能运行）和"回显"（日志、带提示符的
 *   终端记录、要找的关键字）；其他语言是"代码"（只复制）；空的丢掉
 * - 紧跟在命令/回显后面的截图、紧跟在命令后面的回显 → 挂成它的参考回显
 * 命令逐字保留，不拆、不改——保真是导入的底线（宪法 12）。
 */

import { classifyShellText } from './shell-split.ts'

export type DocFormat = 'md' | 'org'

export interface DocBlock {
  kind: 'section' | 'note' | 'command' | 'code' | 'output'
  title: string
  /** 标题是按内容自动取的（界面不单独显示）。 */
  titleAuto: boolean
  bodyMd?: string
  command?: string
  lang?: string
  /** 参考回显（markdown：截图、文本围栏）。 */
  refMd?: string
  /** 原文位置，如 L12-L20。 */
  sourceRef?: string
  children?: DocBlock[]
}

export interface DocImport {
  /** 文档标题（org 的 #+title，或只有一个一级标题时它的文字）。 */
  title: string | null
  blocks: DocBlock[]
  /** 文档里引用到的本地图片（原样的地址），导入时要一起带上。 */
  images: string[]
  stats: { sections: number; notes: number; commands: number; code: number; outputs: number; missingImages: number }
}

export interface ParseOptions {
  /** 本地图片地址 → 可访问的地址；返回 null 表示这张图没带上。 */
  resolveImage?: (ref: string) => string | null
}

const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'ksh', 'fish', 'shellscript', 'sh-session'])
const TRANSCRIPT_LANGS = new Set(['console', 'shell-session', 'terminal'])
const OUTPUT_LANGS = new Set(['text', 'txt', 'log', 'output', 'plaintext', 'plain', 'example', 'stdout', 'stderr'])

/** 代码块语言名的归一（高亮用）。 */
export function normalizeLang(lang: string | null | undefined): string {
  const l = (lang ?? '').trim().toLowerCase()
  if (l === 'sh' || l === 'shell' || l === 'zsh' || l === 'shellscript' || l === 'sh-session') return 'bash'
  if (l === 'py' || l === 'python3') return 'python'
  if (l === 'yml') return 'yaml'
  if (l === 'ps1' || l === 'pwsh') return 'powershell'
  if (l === 'js') return 'javascript'
  if (l === 'ts') return 'typescript'
  return l
}

/** 看文件名和内容猜格式：.org、有 * 标题或 #+begin_src 的是 org，其余按 markdown。 */
export function detectDocFormat(text: string, filename?: string | null): DocFormat {
  const name = (filename ?? '').toLowerCase()
  if (name.endsWith('.org')) return 'org'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md'
  const lines = text.split(/\r?\n/).slice(0, 400)
  let org = 0
  let md = 0
  for (const l of lines) {
    if (/^\*+\s+\S/.test(l)) org++
    if (/^#\+(begin_src|title|end_src|begin_example)/i.test(l)) org += 3
    if (/^#{1,6}\s+\S/.test(l)) md++
    if (/^(```|~~~)/.test(l)) md += 2
  }
  return org > md ? 'org' : 'md'
}

// ── 公共：块树的搭建 ─────────────────────────────────────────

interface Builder {
  roots: DocBlock[]
  stack: Array<{ level: number; block: DocBlock }>
  note: string[]
  noteStart: number
  images: string[]
  missingImages: number
  opts: ParseOptions
}

function container(b: Builder): DocBlock[] {
  const top = b.stack[b.stack.length - 1]
  if (top === undefined) return b.roots
  top.block.children ??= []
  return top.block.children
}

function openSection(b: Builder, level: number, title: string, line: number): void {
  flushNote(b, line)
  while (b.stack.length > 0 && b.stack[b.stack.length - 1]!.level >= level) b.stack.pop()
  const block: DocBlock = { kind: 'section', title: title === '' ? '（无标题）' : title, titleAuto: false, sourceRef: `L${line}`, children: [] }
  container(b).push(block)
  b.stack.push({ level, block })
}

/** 段落里的图片地址换成可访问的地址；没带上的换成醒目的占位。 */
function resolveImages(b: Builder, md: string): string {
  return md.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (whole, alt: string, url: string) => {
    if (/^(?:https?:|data:|\/qb\/)/i.test(url)) return whole
    if (!b.images.includes(url)) b.images.push(url)
    const resolved = b.opts.resolveImage?.(url) ?? null
    if (resolved === null) {
      b.missingImages++
      return `［图片没导入：${url.split('/').pop()}］`
    }
    return `![${alt}](${resolved})`
  })
}

const IMAGE_ONLY = /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/

function flushNote(b: Builder, endLine: number): void {
  const lines = b.note
  b.note = []
  const text = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (text.trim() === '') return

  // 紧跟在命令/回显后面的截图，挂成它的参考回显（原文里截图就是那条命令跑出来的样子）
  const paragraphs = text.split(/\n\s*\n/)
  const siblings = container(b)
  const prev = siblings[siblings.length - 1]
  let i = 0
  if (prev !== undefined && (prev.kind === 'command' || prev.kind === 'output')) {
    const attached: string[] = []
    while (i < paragraphs.length && IMAGE_ONLY.test(paragraphs[i]!)) {
      attached.push(resolveImages(b, paragraphs[i]!.trim()))
      i++
    }
    if (attached.length > 0) prev.refMd = [prev.refMd, ...attached].filter((x) => x !== undefined && x !== '').join('\n\n')
  }
  const rest = paragraphs.slice(i).join('\n\n').trim()
  if (rest === '') return
  const body = resolveImages(b, rest)
  siblings.push({ kind: 'note', title: noteTitle(body), titleAuto: true, bodyMd: body, sourceRef: `L${b.noteStart}-L${endLine - 1}` })
}

function addNoteLine(b: Builder, line: string, n: number): void {
  if (b.note.length === 0) b.noteStart = n
  b.note.push(line)
}

/** 代码块落成命令 / 代码 / 回显。 */
function addFence(b: Builder, langRaw: string, body: string, start: number, end: number): void {
  flushNote(b, start)
  const lang = langRaw.trim().split(/\s+/)[0]!.toLowerCase()
  const text = body.replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (text.trim() === '') return
  const siblings = container(b)
  const prev = siblings[siblings.length - 1]
  const ref = `L${start}-L${end}`

  let kind: DocBlock['kind']
  if (TRANSCRIPT_LANGS.has(lang) || OUTPUT_LANGS.has(lang)) kind = 'output'
  else if (SHELL_LANGS.has(lang)) {
    const c = classifyShellText(text)
    if (c === 'empty') return
    kind = c
  } else kind = 'code'

  // 紧跟在命令后面的回显：挂成这条命令的参考回显
  if (kind === 'output' && prev !== undefined && prev.kind === 'command' && prev.refMd === undefined) {
    prev.refMd = '```text\n' + text + '\n```'
    return
  }
  const norm = normalizeLang(kind === 'output' && SHELL_LANGS.has(lang) ? '' : lang)
  siblings.push({
    kind,
    title: codeTitle(kind, text),
    titleAuto: true,
    command: text,
    ...(norm !== '' ? { lang: norm } : kind === 'command' ? { lang: 'bash' } : {}),
    sourceRef: ref,
  })
}

function newBuilder(opts: ParseOptions): Builder {
  return { roots: [], stack: [], note: [], noteStart: 1, images: [], missingImages: 0, opts }
}

function finish(b: Builder, lineCount: number, title: string | null): DocImport {
  flushNote(b, lineCount + 1)
  const stats = { sections: 0, notes: 0, commands: 0, code: 0, outputs: 0, missingImages: b.missingImages }
  const walk = (xs: DocBlock[]): void => {
    for (const x of xs) {
      if (x.kind === 'section') stats.sections++
      else if (x.kind === 'note') stats.notes++
      else if (x.kind === 'command') stats.commands++
      else if (x.kind === 'code') stats.code++
      else stats.outputs++
      if (x.children !== undefined) walk(x.children)
    }
  }
  walk(b.roots)
  // 只有一个顶层章节时它就是文档标题：拆掉这一层，不然整份文档都缩在一个章节里
  if (title === null && b.roots.length === 1 && b.roots[0]!.kind === 'section') {
    const only = b.roots[0]!
    stats.sections--
    return { title: only.title, blocks: only.children ?? [], images: b.images, stats }
  }
  return { title, blocks: b.roots, images: b.images, stats }
}

// ── markdown ────────────────────────────────────────────────

export function parseMarkdown(text: string, opts: ParseOptions = {}): DocImport {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const b = newBuilder(opts)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const n = i + 1
    const fence = /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(line)
    if (fence !== null) {
      const indent = fence[1]!.length
      const marker = fence[2]!
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!)
        if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break
        body.push(indent > 0 ? lines[j]!.replace(new RegExp(`^ {0,${indent}}`), '') : lines[j]!)
      }
      addFence(b, fence[3]!, body.join('\n'), n, Math.min(j + 1, lines.length))
      i = j
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (heading !== null) {
      openSection(b, heading[1]!.length, heading[2]!.trim(), n)
      continue
    }
    addNoteLine(b, line, n)
  }
  return finish(b, lines.length, null)
}

// ── org-mode ────────────────────────────────────────────────

/** org 的行内写法 → markdown：链接、图片、=代码=、~代码~。 */
export function orgInline(line: string): string {
  return line
    .replace(/\[\[([^\]]+)\]\[([^\]]+)\]\]/g, (_m, url: string, desc: string) => `[${desc}](${orgUrl(url)})`)
    .replace(/\[\[([^\]]+)\]\]/g, (_m, url: string) => {
      const u = orgUrl(url)
      return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(u) ? `![](${u})` : /^https?:/i.test(u) ? `<${u}>` : `[${u}](${u})`
    })
    .replace(/(^|[\s(（"'])[=~]([^\s=~](?:[^=~]*?[^\s=~])?)[=~](?=$|[\s,.;:!?)）。，；：！？"'])/g, (_m, pre: string, code: string) => `${pre}\`${code}\``)
}

function orgUrl(url: string): string {
  return url.replace(/^file:/i, '')
}

/** org 表格：分隔行 |---+---| 换成 markdown 的 |---|---|；没有分隔行的补一行。 */
function orgTable(rows: string[]): string[] {
  const out = rows.map((r) => (/^\s*\|[-+:|\s]+\|?\s*$/.test(r) && r.includes('-') ? r.replace(/\+/g, '|') : r))
  const hasSep = out.some((r) => /^\s*\|[-:|\s]+\|?\s*$/.test(r) && r.includes('-'))
  if (!hasSep && out.length > 0) {
    const cols = Math.max(1, (out[0]!.match(/\|/g)?.length ?? 2) - 1)
    out.splice(1, 0, `|${' --- |'.repeat(cols)}`)
  }
  return out
}

export function parseOrg(text: string, opts: ParseOptions = {}): DocImport {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const b = newBuilder(opts)
  let title: string | null = null
  let table: string[] = []
  let tableStart = 0

  const flushTable = (): void => {
    if (table.length === 0) return
    const rows = orgTable(table)
    for (const r of rows) addNoteLine(b, r, tableStart)
    table = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const n = i + 1

    if (/^\s*\|/.test(line)) {
      if (table.length === 0) tableStart = n
      table.push(line.trim())
      continue
    }
    flushTable()

    const heading = /^(\*+)\s+(.*?)\s*(?::[\w@#%:]+:)?\s*$/.exec(line)
    if (heading !== null) {
      // TODO/DONE 与优先级 [#A] 是 org 的状态标记，不是标题的一部分（自定义的关键字照留）
      const text = heading[2]!.replace(/^(?:TODO|DONE)\s+/, '').replace(/^\[#[A-Z0-9]\]\s+/, '').trim()
      openSection(b, heading[1]!.length, orgInline(text), n)
      continue
    }

    const begin = /^\s*#\+begin_(\w+)\s*(.*)$/i.exec(line)
    if (begin !== null) {
      const type = begin[1]!.toLowerCase()
      const endRe = new RegExp(`^\\s*#\\+end_${type}\\s*$`, 'i')
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length && !endRe.test(lines[j]!); j++) body.push(lines[j]!.replace(/^,(\*|#\+)/, '$1'))
      const content = body.join('\n')
      if (type === 'src') addFence(b, begin[2]!.split(/\s+/)[0] ?? '', content, n, Math.min(j + 1, lines.length))
      else if (type === 'example') addFence(b, 'text', content, n, Math.min(j + 1, lines.length))
      else if (type === 'quote' || type === 'verse' || type === 'center') {
        for (const l of body) addNoteLine(b, `> ${orgInline(l)}`, n)
        addNoteLine(b, '', n)
      } else addFence(b, type, content, n, Math.min(j + 1, lines.length))
      i = j
      continue
    }

    const keyword = /^\s*#\+(\w+):\s*(.*)$/.exec(line)
    if (keyword !== null) {
      if (keyword[1]!.toLowerCase() === 'title' && title === null) title = keyword[2]!.trim() || null
      continue
    }
    // 抽屉（:PROPERTIES: … :END:）、计划时间、org 注释（"# " 开头）都不是正文
    if (/^\s*:[A-Z_]+:\s*$/.test(line)) {
      let j = i + 1
      while (j < lines.length && !/^\s*:END:\s*$/i.test(lines[j]!)) j++
      i = j
      continue
    }
    if (/^\s*(?:SCHEDULED|DEADLINE|CLOSED):/.test(line)) continue
    if (/^\s*#(?:\s|$)/.test(line)) continue

    addNoteLine(b, orgInline(line), n)
  }
  flushTable()
  return finish(b, lines.length, title)
}

export function parseDocument(text: string, format: DocFormat, opts: ParseOptions = {}): DocImport {
  return format === 'org' ? parseOrg(text, opts) : parseMarkdown(text, opts)
}

// ── 标题 ────────────────────────────────────────────────────

const TITLE_MAX = 48

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t
}

/** 文字块的标题：第一行去掉 markdown 记号；只有图片时叫"图片"。 */
export function noteTitle(md: string): string {
  for (const raw of md.split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:#+|[>*+-]|\d+[.)])\s*/, '')
      // 强调记号去掉，词里的下划线（ASCEND_RT_VISIBLE_DEVICES）留着
      .replace(/\*\*|__(?=\S)|(?<=\S)__|[*`|]/g, '')
      .trim()
    if (line !== '' && !/^[-:\s]+$/.test(line)) return clip(line)
  }
  return /!\[/.test(md) ? '图片' : '文字'
}

/** 命令/代码/回显块的标题：第一条有内容的行（去掉 sudo、环境变量前缀、提示符）。 */
export function codeTitle(kind: 'command' | 'code' | 'output' | string, text: string): string {
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (line === '' || (kind === 'command' && line.startsWith('#'))) continue
    line = line.replace(/^(?:\[[^\]]+\][#$]|[\w.-]+@[\w.-]+:\S*[#$])\s*/, '')
    if (kind === 'command') line = line.replace(/^(?:sudo\s+)?(?:\w+=\S+\s+)+/, '').replace(/^nohup\s+/, '')
    line = line.replace(/\s*\\$/, '')
    if (line !== '') return clip(line)
  }
  return kind === 'output' ? '回显' : kind === 'code' ? '代码' : '命令'
}
