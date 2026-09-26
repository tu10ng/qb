/**
 * 终端记录的切分与匹配（纯函数）。
 *
 * L0.5（方案 §8）：一次贴一大段跨多步的终端输出，按提示符切成
 * "命令 + 输出"，再按命令匹配回 runbook 的步骤，各自成为证据。
 * 切分是确定性的；模型不参与。
 */

import { normLine } from './fidelity.ts'
import { render } from './params.ts'
import type { Param } from './schema.ts'

export interface TranscriptBlock {
  /** 用户敲的那行命令（不含提示符）。 */
  command: string
  /** 命令之后、下一个提示符之前的全部输出。 */
  output: string
}

/** 常见提示符形态：[root@gpu-17 ~]#、user@host:~$、$、#、PS C:\>、续行 >。 */
const PROMPTS: RegExp[] = [
  /^\[[^\]\n]{1,80}\][#$]\s?/, // [root@gpu-17 ~]#
  /^[\w.-]+@[\w.-]+:[^\s]{0,60}[#$]\s?/, // tu10ng@gpu-17:~$
  /^[#$]\s?/, // $ / #
  /^>\s?/, // bash 续行提示符（反斜杠换行后）
  /^[A-Za-z]:\\[^>\n]{0,80}>\s?/, // PS C:\Users\x>
  /^\([^)\n]{1,30}\)\s?[\w.@-]*[:#$]? ?/, // (venv) user@host:~$
]

/**
 * 按提示符切分终端记录。
 *
 * 认不出提示符的行全部归入当前块的输出；第一个提示符之前的内容
 * （比如 SSH 横幅）丢弃。反斜杠续行并入同一条命令。
 */
export function splitTranscript(text: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let current: TranscriptBlock | null = null

  for (const raw of text.split(/\r?\n/)) {
    const prompt = matchPrompt(raw)
    if (prompt === null) {
      if (current !== null) current.output += (current.output === '' ? '' : '\n') + raw
      continue
    }

    const command = raw.slice(prompt.length).trim()
    if (command === '') continue
    if (current !== null && current.command.endsWith('\\')) {
      // 续行：上一行以反斜杠结尾
      current.command = `${current.command.slice(0, -1).trimEnd()} ${command}`
      continue
    }
    current = { command, output: '' }
    blocks.push(current)
  }

  // 挂在最后一条命令上的续行已就地处理；去掉每条命令的续行符残留
  return blocks
}

function matchPrompt(line: string): string | null {
  for (const re of PROMPTS) {
    const m = re.exec(line)
    if (m !== null) return m[0]
  }
  return null
}

// ── 匹配回步骤 ───────────────────────────────────────────────

export interface StepLike {
  id: string
  command: string | null
}

export interface BlockMatch {
  blockIndex: number
  stepId: string | null
  /** 归一化后完全一致 / 渲染值是块命令的子串（带前缀装饰时）。 */
  exact: boolean
}

/**
 * 把每块命令匹配到步骤上。
 *
 * 一段输出里用户可能敲了些 runbook 之外的命令（查看状态之类），匹配
 * 不上的块照常返回（stepId=null），调用方只需提示"有 N 条没对上步骤"。
 */
export function matchBlocks(blocks: TranscriptBlock[], steps: StepLike[], params: Param[]): BlockMatch[] {
  const rendered = new Map<string, string>()
  for (const s of steps) {
    if (s.command !== null && s.command.trim() !== '') rendered.set(s.id, normLine(render(s.command, params).text))
  }

  return blocks.map((b, blockIndex) => {
    const cmd = normLine(b.command)
    if (cmd === '') return { blockIndex, stepId: null, exact: false }

    let bestId: string | null = null
    let bestExact = false
    for (const [id, stepCmd] of rendered) {
      if (stepCmd === cmd) {
        bestId = id
        bestExact = true
        break
      }
      // 终端里敲的命令可能带前缀（CUDA_VISIBLE_DEVICES=…）或后缀重定向，
      // 步骤命令是它的子串时也算命中
      if (!bestExact && cmd.includes(stepCmd) && stepCmd.length >= 8) bestId = id
    }
    return { blockIndex, stepId: bestId, exact: bestExact }
  })
}
