/**
 * 保真与覆盖检查（纯函数，不靠模型自觉——方案 §3.2）。
 *
 * 保真：每行命令把参数替换回原值后，必须逐字出现在素材里；对不上就
 * 标"QB 改写过"，并给出素材里最接近的那一行供一键还原。
 * 覆盖：素材里像命令的行没被任何步骤用上时列出来。
 */

import { render, type Rendered } from './params.ts'
import type { Param } from './schema.ts'

/** 空白归一：把连续空白压成一个空格再比（抄写时的缩进差异不算改动）。 */
export function normLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 常见命令起始词。用于从素材里认出"像命令的行"（覆盖检查的候选）。 */
const COMMAND_STARTERS = new Set([
  'sudo', 'export', 'cd', 'ls', 'cat', 'grep', 'awk', 'sed', 'curl', 'wget', 'tar', 'unzip',
  'git', 'pip', 'pip3', 'python', 'python3', 'node', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl',
  'helm', 'ssh', 'scp', 'rsync', 'cp', 'mv', 'rm', 'mkdir', 'chmod', 'chown', 'ln', 'touch',
  'echo', 'tail', 'head', 'less', 'more', 'tee', 'which', 'whereis', 'env', 'source', 'alias',
  'nvidia-smi', 'nvcc', 'vllm', 'ray', 'torchrun', 'systemctl', 'journalctl', 'service',
  'apt', 'apt-get', 'yum', 'dnf', 'brew', 'conda', 'uv', 'make', 'cmake', 'gcc', 'go', 'cargo',
  'nohup', 'timeout', 'watch', 'xargs', 'find', 'du', 'df', 'free', 'top', 'htop', 'ps', 'kill',
  'pkill', 'ss', 'netstat', 'lsof', 'ping', 'traceroute', 'dig', 'nslookup', 'ip', 'ifconfig',
  'useradd', 'groupadd', 'passwd', 'crontab', 'date', 'uname', 'hostname', 'id', 'whoami',
  'md5sum', 'sha256sum', 'base64', 'jq', 'yq', 'hugo', 'terraform', 'ansible', 'pytest',
])

/**
 * 从素材里认出像命令的行：代码块内容、缩进 4 格/Tab 的行、以常见命令
 * 起始词开头的行。误报没关系（只是覆盖提示），漏报才有关系。
 */
export function commandLinesOf(source: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let inFence = false

  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    // 代码块里除注释和空行外都算命令候选
    const inCode = inFence || /^(?: {4}|\t)\S/.test(raw)
    const first = trimmed.split(/\s+/)[0]!.replace(/[;|&]+$/, '')
    const starter = COMMAND_STARTERS.has(first) || /^[A-Z_][A-Z0-9_]*=/.test(trimmed)
    const envPrefix = trimmed.startsWith('CUDA_VISIBLE_DEVICES=') || trimmed.startsWith('NCCL_')
    const isCmd = inCode || starter || envPrefix
    if (!isCmd || trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue

    const norm = normLine(trimmed)
    if (norm === '' || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

export interface FidelityItem {
  /** 步骤在输入里的下标。 */
  index: number
  rendered: string
  /** 模板里有缺值/未声明参数，没法验证。 */
  unverified: boolean
  verbatim: boolean
  /** 素材里最接近的命令行（verbatim=false 或需要对照时给出）。 */
  closest?: string
}

export interface FidelityReport {
  items: FidelityItem[]
  /** 素材里没被任何步骤用上的命令行。 */
  uncovered: string[]
}

/**
 * 逐条检查命令保真，并给出覆盖情况。
 *
 * @param commands 步骤的命令模板（可为空串表示该步无命令）
 */
export function checkFidelity(commands: string[], source: string, params: Param[]): FidelityReport {
  const normSource = normLine(source)
  const sourceCmds = commandLinesOf(source)
  const items: FidelityItem[] = []
  const used: string[] = []

  commands.forEach((template, index) => {
    const t = template.trim()
    if (t === '') return
    const r: Rendered = render(t, params)

    if (r.missing.length > 0 || r.undeclared.length > 0) {
      items.push({ index, rendered: r.text, unverified: true, verbatim: false })
      return
    }

    const rendered = normLine(r.text)
    const verbatim = normSource.includes(rendered)
    const closest = verbatim ? undefined : closestLine(rendered, sourceCmds)
    items.push({ index, rendered: r.text, unverified: false, verbatim, ...(closest !== undefined ? { closest } : {}) })
    used.push(rendered)
  })

  // 覆盖：素材命令行没有被任何步骤的渲染值覆盖。渲染值是素材行的超集
  // 也算用过——终端里常给命令加前缀（export X=… &&）或 nohup 装饰
  const uncovered = sourceCmds.filter(
    (line) => !used.some((u) => u === line || (u.includes(line) && line.length >= 8)),
  )

  return { items, uncovered }
}

/** 编辑距离（Levenshtein），带长度差剪枝——只为了找"最接近的那行"。 */
function closestLine(rendered: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const d = Math.abs(c.length - rendered.length) + levenshtein(rendered, c, bestDist)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      cur.push(v)
      rowMin = Math.min(rowMin, v)
    }
    if (rowMin > cap) return cap + 1
    prev = cur
  }
  return prev[b.length]!
}
