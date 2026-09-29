/**
 * 代码高亮与 markdown 渲染（界面用）。
 *
 * - 高亮只注册常用的十几种语言（按需引入，包小一半）；认不出的语言按纯文本
 * - markdown 用 markdown-it，关掉原始 HTML（文档可能来自别人，不执行任何
 *   脚本）；链接一律新窗口打开；本机图片地址照原样
 */

import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import makefile from 'highlight.js/lib/languages/makefile'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import markdownit, { type RendererRule } from 'markdown-it'

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, diff, dockerfile, go, ini, javascript, json, makefile, plaintext, powershell, python, sql, typescript, xml, yaml,
}
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def)
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['py', 'python3'], { languageName: 'python' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['toml', 'conf', 'cfg'], { languageName: 'ini' })
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' })
hljs.registerAliases(['js'], { languageName: 'javascript' })
hljs.registerAliases(['ts'], { languageName: 'typescript' })
hljs.registerAliases(['html'], { languageName: 'xml' })
hljs.registerAliases(['text', 'txt', 'log', 'output'], { languageName: 'plaintext' })

/** 语言下拉里给的选项（顺序即常用程度）。 */
export const LANGUAGE_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'bash', label: 'bash' },
  { id: 'python', label: 'python' },
  { id: 'json', label: 'json' },
  { id: 'yaml', label: 'yaml' },
  { id: 'ini', label: 'ini / conf' },
  { id: 'dockerfile', label: 'dockerfile' },
  { id: 'powershell', label: 'powershell' },
  { id: 'sql', label: 'sql' },
  { id: 'diff', label: 'diff' },
  { id: 'javascript', label: 'javascript' },
  { id: 'typescript', label: 'typescript' },
  { id: 'go', label: 'go' },
  { id: 'cpp', label: 'c / c++' },
  { id: 'makefile', label: 'makefile' },
  { id: 'xml', label: 'xml / html' },
  { id: 'plaintext', label: '纯文本' },
]

/** 这门语言能不能高亮。 */
export function knownLanguage(lang: string | null | undefined): boolean {
  return lang != null && lang !== '' && hljs.getLanguage(lang) !== undefined
}

/** 高亮成 HTML（已转义）；认不出的语言原样转义。 */
export function highlightHtml(code: string, lang: string | null | undefined): string {
  if (knownLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang!, ignoreIllegals: true }).value
    } catch {
      /* 落到下面按纯文本 */
    }
  }
  return escapeHtml(code)
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── markdown ────────────────────────────────────────────────

const md = markdownit({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code: string, lang: string) => highlightHtml(code, lang),
})

// 链接新窗口打开，并且不把本页带给对方（noopener）
const fallbackLink: RendererRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options)
const defaultLink: RendererRule = md.renderer.rules.link_open ?? fallbackLink
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!
  t.attrSet('target', '_blank')
  t.attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, idx, options, env, self)
}

/** markdown → HTML。原始 HTML 不执行（html:false），只出安全的标签。 */
export function renderMarkdown(text: string): string {
  return md.render(text)
}
