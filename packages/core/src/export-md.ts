/**
 * runbook → markdown（纯函数）：手册从 md/org 导进来，也得能原样导出去——
 * 发给没装 QB 的人、贴进 wiki、存档。
 *
 * 章节 → 标题（按层级），文字 → 原文，命令/代码 → 围栏（命令按参数渲染，
 * secret 打码），回显 → text 围栏，参考回显跟在命令后面。要做的步骤的标题
 * 用加粗行（不是自动取的才写）。
 */

import { redactSecrets, render } from './params.ts'
import type { Param, Step } from './schema.ts'
import { ancestorsOf, isSection } from './tree.ts'

export interface ExportOptions {
  /** 命令里的 {{参数}} 换成值（默认换）；secret 永远打码。 */
  renderParams?: boolean
}

export function exportMarkdown(title: string, steps: Step[], params: Param[], opts: ExportOptions = {}): string {
  const renderParams = opts.renderParams ?? true
  const out: string[] = [`# ${title}`, '']
  const scrub = (t: string): string => redactSecrets(t, params).text
  const body = (t: string): string => scrub(renderParams ? render(t, params).text : t)
  const fence = (text: string, lang: string | null): string => {
    // 正文里有 ``` 时围栏加长，不会提前闭合
    const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length))
    const tick = '`'.repeat(longest + 1)
    return `${tick}${lang ?? ''}\n${text.replace(/\s+$/, '')}\n${tick}`
  }

  for (const s of steps) {
    const depth = ancestorsOf(steps, s).length
    if (isSection(s)) {
      out.push(`${'#'.repeat(Math.min(6, depth + 2))} ${s.title}`, '')
      continue
    }
    switch (s.kind) {
      case 'note':
        if ((s.bodyMd ?? '').trim() !== '') out.push(scrub(s.bodyMd!.trim()), '')
        break
      case 'code':
        if (s.command !== null) out.push(fence(body(s.command), s.lang), '')
        break
      case 'output':
        if (s.command !== null) out.push(fence(scrub(s.command), 'text'), '')
        break
      default: {
        if (!s.titleAuto) out.push(`**${s.title}**`, '')
        if (s.whyMd !== null && s.whyMd.trim() !== '') out.push(scrub(s.whyMd.trim()), '')
        if (s.command !== null && s.command.trim() !== '') out.push(fence(body(s.command), s.lang ?? 'sh'), '')
        if (s.refMd !== null && s.refMd.trim() !== '') out.push(scrub(s.refMd.trim()), '')
      }
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
