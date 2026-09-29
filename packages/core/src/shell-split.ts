/**
 * 按 shell 语法把一段文本切成若干条命令（纯函数）。
 *
 * 粘贴多行命令时问"拆成 N 步？"、导入时判断代码块像不像命令，都靠它。
 * 逐行切会把续行（\）、跨行的引号（--kv-transfer-config '{…}'）、heredoc、
 * for/if 块切碎——实测一条 docker run 被拆成 5 步。这里认这几种结构：
 * - 行尾反斜杠续行
 * - 跨行的单/双引号、反引号
 * - heredoc（<<EOF … EOF、<<-EOF、<<'EOF'）
 * - 行尾是 | && || 的管道/逻辑续行
 * - if/fi、for/while/until…done、case/esac、{ }、( ) 的嵌套
 * 注释行（# 开头）挂到下一条命令上，拆步时当标题。
 */

export interface ShellCommand {
  /** 命令原文（可能多行，保留缩进与续行符）。 */
  text: string
  /** 紧挨在它前面的注释（去掉 #），拆步时当标题。 */
  comment: string | null
  /** 在原文里的起止行（从 1 起，含两端）。 */
  startLine: number
  endLine: number
}

const OPENERS: Record<string, string> = { if: 'fi', case: 'esac', for: 'done', while: 'done', until: 'done', select: 'done' }
const CLOSERS = new Set(['fi', 'esac', 'done'])
/** 这些词之后又回到"命令开头"的位置（then 后面可以再跟 if）。 */
const RESET_WORDS = new Set(['then', 'do', 'else', 'elif', '!', 'time'])

interface ScanState {
  quote: '' | "'" | '"' | '`'
  /** 块关键字与括号的栈：'fi' / 'done' / 'esac' / ')' / '}'。 */
  stack: string[]
  /** 等着结束的 heredoc 分隔符（按出现顺序）。 */
  heredocs: Array<{ word: string; stripTabs: boolean }>
}

/** 扫一行（不在 heredoc 正文里），更新引号/嵌套/heredoc 状态。返回这一行末尾是否要求续行。 */
function scanLine(line: string, st: ScanState): boolean {
  let i = 0
  let commandPos = st.quote === ''
  let word = ''
  let continued = false

  const endWord = (): void => {
    if (word === '') return
    const w = word
    word = ''
    if (!commandPos) return
    if (OPENERS[w] !== undefined) {
      st.stack.push(OPENERS[w]!)
      commandPos = false
    } else if (CLOSERS.has(w)) {
      const idx = st.stack.lastIndexOf(w)
      if (idx >= 0) st.stack.splice(idx, 1)
      commandPos = false
    } else if (RESET_WORDS.has(w)) {
      commandPos = true
    } else if (w === '{') {
      st.stack.push('}')
      commandPos = true
    } else if (w === '}') {
      const idx = st.stack.lastIndexOf('}')
      if (idx >= 0) st.stack.splice(idx, 1)
      commandPos = false
    } else {
      commandPos = false
    }
  }

  while (i < line.length) {
    const c = line[i]!
    if (st.quote === "'") {
      if (c === "'") st.quote = ''
      i++
      continue
    }
    if (st.quote === '"' || st.quote === '`') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === st.quote) st.quote = ''
      i++
      continue
    }

    if (c === '\\') {
      if (i === line.length - 1) {
        continued = true
        i++
        continue
      }
      word += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      st.quote = c
      word += 'q'
      i++
      continue
    }
    if (c === '#' && word === '') {
      // 注释到行尾
      break
    }
    if (c === '$' && line[i + 1] === '{') {
      // ${VAR} 里的大括号不是代码块
      const close = line.indexOf('}', i + 2)
      word += line.slice(i, close < 0 ? line.length : close + 1)
      i = close < 0 ? line.length : close + 1
      continue
    }
    if (c === '$' && line[i + 1] === '(') {
      st.stack.push(')')
      word += '$('
      i += 2
      continue
    }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(line.slice(i))
      if (m !== null) {
        st.heredocs.push({ word: m[3]!, stripTabs: m[1] === '-' })
        i += m[0].length
        continue
      }
    }
    if (c === '(') {
      endWord()
      st.stack.push(')')
      commandPos = true
      i++
      continue
    }
    if (c === ')') {
      endWord()
      // case 的分支 a) 没有左括号：栈顶不是 ) 就不算
      if (st.stack[st.stack.length - 1] === ')') st.stack.pop()
      commandPos = false
      i++
      continue
    }
    if (c === ';' || c === '&' || c === '|') {
      endWord()
      commandPos = true
      i++
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    word += c
    i++
  }
  if (st.quote === '') endWord()
  if (continued) return true

  // 行尾是管道或 && || ：下一行接着写
  const tail = line.replace(/\s+#[^'"]*$/, '').trimEnd()
  return st.quote === '' && /(?:\||&&|\|\|)$/.test(tail) && !tail.endsWith(';;')
}

/** 切成若干条命令；注释行挂到紧跟的命令上。 */
export function splitShellCommands(text: string): ShellCommand[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ShellCommand[] = []
  const st: ScanState = { quote: '', stack: [], heredocs: [] }
  let current: string[] = []
  let startLine = 0
  let comments: string[] = []
  let continued = false

  const finish = (endLine: number): void => {
    const body = current.join('\n').replace(/\s+$/, '')
    if (body.trim() !== '') {
      out.push({ text: body, comment: comments.length > 0 ? comments.join(' ') : null, startLine, endLine })
    }
    current = []
    comments = []
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!

    // heredoc 正文：原样收下，直到分隔符
    if (st.heredocs.length > 0) {
      current.push(line)
      const h = st.heredocs[0]!
      const probe = h.stripTabs ? line.replace(/^\t+/, '') : line
      if (probe.trim() === h.word) st.heredocs.shift()
      if (st.heredocs.length === 0 && st.stack.length === 0 && st.quote === '' && !continued) finish(n + 1)
      continue
    }

    const trimmed = line.trim()
    if (current.length === 0 && st.quote === '') {
      if (trimmed === '') continue
      if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
        comments.push(trimmed.replace(/^#+\s?/, ''))
        continue
      }
      startLine = n + 1
    }

    current.push(line)
    continued = scanLine(line, st)
    if (!continued && st.quote === '' && st.stack.length === 0 && st.heredocs.length === 0) finish(n + 1)
  }
  if (current.length > 0) finish(lines.length)
  return out
}

/** 一段文本里有几条命令。 */
export function countShellCommands(text: string): number {
  return splitShellCommands(text).length
}

/** 常见命令起始词：认"像命令的行"。误报没关系，漏报才有关系。 */
export const COMMAND_STARTERS: ReadonlySet<string> = new Set([
  'sudo', 'export', 'unset', 'set', 'cd', 'ls', 'll', 'cat', 'grep', 'egrep', 'awk', 'sed', 'curl', 'wget', 'tar', 'unzip', 'zip',
  'git', 'pip', 'pip3', 'python', 'python3', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'docker', 'podman', 'kubectl',
  'helm', 'ssh', 'scp', 'rsync', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'ln', 'touch',
  'echo', 'printf', 'tail', 'head', 'less', 'more', 'tee', 'which', 'whereis', 'type', 'env', 'source', '.', 'alias',
  'nvidia-smi', 'nvcc', 'npu-smi', 'hccn_tool', 'ascend-dmi', 'vllm', 'ray', 'torchrun', 'accelerate', 'deepspeed',
  'systemctl', 'journalctl', 'service', 'apt', 'apt-get', 'yum', 'dnf', 'rpm', 'dpkg', 'brew', 'conda', 'mamba', 'uv',
  'make', 'cmake', 'gcc', 'g++', 'go', 'cargo', 'java', 'mvn', 'gradle',
  'nohup', 'timeout', 'watch', 'xargs', 'find', 'locate', 'du', 'df', 'free', 'top', 'htop', 'ps', 'kill', 'killall',
  'pkill', 'pgrep', 'ss', 'netstat', 'lsof', 'ping', 'telnet', 'nc', 'traceroute', 'dig', 'nslookup', 'ip', 'ifconfig',
  'useradd', 'groupadd', 'passwd', 'crontab', 'date', 'uname', 'hostname', 'id', 'whoami', 'uptime', 'dmesg', 'lspci',
  'lscpu', 'lsblk', 'mount', 'umount', 'ulimit', 'sysctl', 'modprobe', 'lsmod',
  'md5sum', 'sha256sum', 'base64', 'jq', 'yq', 'terraform', 'ansible', 'pytest', 'vim', 'vi', 'nano', 'tmux', 'screen',
  'bash', 'sh', 'zsh', 'exec', 'for', 'while', 'if', 'case', 'history', 'clear', 'exit', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff',
])

/** 终端提示符：[root@host ~]#、user@host:~$、root@host:/workspace#。 */
const PROMPT_LINE = /^(?:\[[^\]\n]{1,80}\][#$]|[\w.-]+@[\w.-]+:[^\s]{0,60}[#$])\s/

/** 这一行像不像一条命令的开头。 */
export function isCommandLike(line: string): boolean {
  let t = line.trim()
  if (t === '' || t.startsWith('#')) return false
  // 去掉 sudo 和 FOO=bar 这种前缀
  t = t.replace(/^sudo\s+/, '')
  if (/^[A-Za-z_][\w]*=\S*(\s|$)/.test(t)) return true
  const first = t.split(/\s+/)[0]!.replace(/[;|&]+$/, '')
  if (COMMAND_STARTERS.has(first)) return true
  if (/^(?:\.{1,2}|~)?\/\S+/.test(first)) return true
  return /\.(?:sh|py)$/.test(first)
}

/** 这一行是不是带提示符的终端记录。 */
export function isPromptLine(line: string): boolean {
  return PROMPT_LINE.test(line)
}

/**
 * 一段 shell 代码块是命令还是回显：带提示符的是终端记录（回显）；没有一行
 * 像命令（日志、关键字、"Application startup complete."）的是回显；其余是命令。
 */
export function classifyShellText(text: string): 'command' | 'output' | 'empty' {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const meaningful = lines.filter((l) => l !== '' && !l.startsWith('#'))
  if (meaningful.length === 0) return lines.some((l) => l.startsWith('#')) ? 'command' : 'empty'
  if (lines.some(isPromptLine)) return 'output'
  return meaningful.some(isCommandLike) ? 'command' : 'output'
}
