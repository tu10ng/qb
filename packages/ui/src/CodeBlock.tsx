import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { segmentTemplate, type Param } from '@qb/core'
import { escapeHtml, highlightHtml } from './highlight.ts'

/** 选中了哪几行（从 1 起，含两端）。 */
export interface LineRange {
  from: number
  to: number
}

interface EditorProps {
  value: string
  lang: string | null
  placeholder?: string
  autoFocus?: boolean
  onChange: (next: string) => void
  /** 失焦或 Ctrl+Enter 保存；Esc 取消。 */
  onCommit: () => void
  onCancel: () => void
  /** 粘贴拦截（拆步、识别机器行）：返回 true 表示已处理，不再插入。 */
  onPaste?: (text: string, e: React.ClipboardEvent<HTMLTextAreaElement>) => boolean
}

/**
 * 代码编辑框：透明的 textarea 叠在高亮层上面，随内容长高，不出现内部
 * 滚动条和右下角的拉伸抓手（原先两个都有，又不会自己变高）。
 */
export function CodeEditor({ value, lang, placeholder, autoFocus = true, onChange, onCommit, onCancel, onPaste }: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!autoFocus) return
    const el = ref.current
    if (el === null) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [autoFocus])

  // 末尾是换行时浏览器不给最后一行留高度：高亮层补一个空格，两层对齐
  const html = useMemo(() => `${highlightHtml(value, lang)}${value.endsWith('\n') || value === '' ? ' ' : ''}`, [value, lang])

  return (
    <div className="code-edit" onClick={(e) => e.stopPropagation()}>
      <pre className="code-layer hljs" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        ref={ref}
        className="code-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        wrap="soft"
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false
            onCancel()
          } else onCommit()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            cancelled.current = true
            ref.current?.blur()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // 命令里要打缩进；不能用 Tab 跳走（跳出去用 Esc / 点别处）
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = el
            onChange(`${value.slice(0, a)}  ${value.slice(b)}`)
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
          }
        }}
        onPaste={(e) => {
          if (onPaste === undefined) return
          const text = e.clipboardData.getData('text/plain')
          if (onPaste(text, e)) e.preventDefault()
        }}
      />
    </div>
  )
}

interface ViewProps {
  /** 已经高亮、替换好参数的 HTML（全部转义过）。 */
  html: string
  onClick?: (e: React.MouseEvent) => void
  /** 选中范围变化（松开鼠标时报一次）：界面据此给出"运行/复制选中的几行"。 */
  onSelectLines?: (range: LineRange | null) => void
  className?: string
}

/** 只读的代码块：高亮显示；拖选几行时报出选中的是第几行到第几行。 */
export function CodeView({ html, onClick, onSelectLines, className = '' }: ViewProps) {
  const ref = useRef<HTMLPreElement>(null)

  const report = (): void => {
    if (onSelectLines === undefined || ref.current === null) return
    onSelectLines(selectedLines(ref.current))
  }

  return <pre ref={ref} className={`code-view hljs ${className}`} onMouseUp={report} onKeyUp={report} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

/** 当前的文本选区落在这个 pre 里的哪几行（整行都算上）；没选中返回 null。 */
function selectedLines(pre: HTMLElement): LineRange | null {
  const sel = window.getSelection()
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) return null
  const offsetOf = (node: Node, offset: number): number => {
    const r = document.createRange()
    r.selectNodeContents(pre)
    r.setEnd(node, offset)
    return r.toString().length
  }
  const text = pre.textContent ?? ''
  const a = offsetOf(range.startContainer, range.startOffset)
  const b = offsetOf(range.endContainer, range.endOffset)
  if (b <= a) return null
  const lineAt = (i: number): number => text.slice(0, i).split('\n').length
  // 选区结束正好在行首（拖到下一行开头）时不算那一行
  const endIndex = text[b - 1] === '\n' ? b - 1 : b
  return { from: lineAt(a), to: lineAt(Math.max(a, endIndex)) }
}

/** 自动长高的普通文本框（贴输出、写 markdown）：没有抓手，内容多少就多高。 */
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxHeight?: number }) {
  const { minRows = 1, maxHeight, className = '', ...rest } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  const [, force] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    el.style.height = 'auto'
    const h = el.scrollHeight + 2
    el.style.height = `${maxHeight !== undefined ? Math.min(h, maxHeight) : h}px`
    el.style.overflowY = maxHeight !== undefined && h > maxHeight ? 'auto' : 'hidden'
  })
  return (
    <textarea
      ref={ref}
      rows={minRows}
      className={`auto-textarea ${className}`}
      {...rest}
      onChange={(e) => {
        rest.onChange?.(e)
        force((n) => n + 1)
      }}
    />
  )
}


/**
 * 模板 → 高亮后的 HTML，参数换成下划线的槽（悬停显示名字，点一下去参数
 * 面板改值）；secret 显示成圆点，缺值的原样标红。
 *
 * 做法：先按原文高亮（引用 {{名字}} 原样留在里面），再在高亮后的 HTML 里
 * 按"原文字符位置"找回每处引用、整段换成槽。高亮器会吞掉不认识的字符，
 * 所以不能用占位符；而 HTML 里除了标签和实体，其余字符与原文一一对应。
 */
export function templateHtml(template: string, params: Param[], lang: string | null): string {
  const spans: Array<{ start: number; end: number; html: string }> = []
  let at = 0
  for (const s of segmentTemplate(template, params)) {
    if (s.kind === 'text') {
      at += s.text.length
      continue
    }
    const shown = s.value === null ? s.raw : s.secret ? '••••••' : s.value
    const cls = s.undeclared ? 'param-slot undeclared' : s.value === null ? 'param-slot missing' : s.secret ? 'param-slot secret' : 'param-slot'
    const tip = s.undeclared ? `${s.ref}（还没声明）` : s.value === null ? `${s.ref}（缺值）` : s.secret ? `${s.ref}（secret）` : s.ref
    spans.push({ start: at, end: at + s.raw.length, html: `<span class="${cls}" data-param="${escapeHtml(s.name)}" title="${escapeHtml(tip)}">${escapeHtml(shown)}</span>` })
    at += s.raw.length
  }
  const html = highlightHtml(template, lang)
  return spans.length === 0 ? html : replaceByTextOffset(html, spans)
}

/**
 * 在一段 HTML 里按"文本字符位置"替换若干区间（区间按起点升序、不重叠）。
 * 区间跨了高亮器的标签（{{ 和名字被拆进不同的 span）时，区间里的标签不
 * 输出，但记下它们的开合，区间结束后补上还开着的——HTML 结构不会错位。
 */
export function replaceByTextOffset(html: string, spans: Array<{ start: number; end: number; html: string }>): string {
  let out = ''
  let text = 0
  let i = 0
  let k = 0
  let inside = false
  // 区间里遇到的标签：净打开的在区间结束后补开；净关闭的照样输出（关掉区间外开的）
  const stack: string[] = []
  const flushAt = (): void => {
    for (;;) {
      const span = spans[k]
      if (span === undefined) return
      if (!inside && text === span.start) {
        out += span.html
        inside = true
        if (span.end === span.start) continue
      }
      if (inside && text === span.end) {
        inside = false
        for (const tag of stack) out += tag
        stack.length = 0
        k++
        continue
      }
      return
    }
  }
  while (i < html.length) {
    flushAt()
    const c = html[i]!
    if (c === '<') {
      const close = html.indexOf('>', i)
      const tag = html.slice(i, close + 1)
      if (!inside) out += tag
      else if (!tag.startsWith('</')) stack.push(tag)
      else if (stack.length > 0) stack.pop()
      else out += tag
      i = close + 1
      continue
    }
    const len = c === '&' ? html.indexOf(';', i) - i + 1 : 1
    if (!inside) out += html.slice(i, i + len)
    i += len
    text++
  }
  flushAt()
  return out
}
