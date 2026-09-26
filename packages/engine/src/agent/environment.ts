import type { EnvironmentFacts } from '@qb/core'
import type { HostPort } from '../dsh/port.ts'

/**
 * 采集本机环境事实。
 *
 * 这些事实会注入起草提示词，让 QB 生成的命令贴合实际环境
 * （路径分隔符、shell 语法、有没有 GPU、要不要走代理）。
 *
 * 探测命令按 dsh 的真实 shell 写：Windows 上是 PowerShell 5.1
 * （不是 cmd，也不是 git-bash），POSIX 上是 bash。每项独立失败，
 * 没装 CUDA 不该让整次采集失效。
 */
export async function collectEnvironment(host: HostPort): Promise<EnvironmentFacts> {
  const isWindows = process.platform === 'win32'

  const [os, shell, gpu, cuda] = await Promise.all([
    probe(
      host,
      isWindows
        ? '[System.Environment]::OSVersion.VersionString'
        : 'grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 || uname -sr',
    ),
    probe(
      host,
      isWindows ? '"PowerShell " + $PSVersionTable.PSVersion.ToString()' : 'echo $SHELL',
    ),
    probe(host, 'nvidia-smi --query-gpu=name --format=csv,noheader'),
    probe(host, 'nvcc --version'),
  ])

  const facts: EnvironmentFacts = { arch: process.arch }

  if (os !== null) facts.os = clean(os)
  if (shell !== null) facts.shell = clean(shell)

  if (gpu !== null) {
    const lines = gpu.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    if (lines.length > 0) {
      // 多卡同型号合并成 "8× NVIDIA H800"
      facts.gpu = lines.length > 1 ? `${lines.length}× ${lines[0]!}` : lines[0]!
    }
  }

  if (cuda !== null) {
    const m = /release (\d+\.\d+)/.exec(cuda)
    if (m !== null) facts.cuda = m[1]!
  }

  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (proxy !== undefined && proxy !== '') facts.proxy = proxy

  const quirks: string[] = []
  if (isWindows) {
    quirks.push('shell 是 PowerShell 5.1，不是 bash：路径用反斜杠，环境变量写 $env:NAME，管道语义不同')
  }
  if (facts.gpu === undefined) {
    quirks.push('本机没有 NVIDIA GPU，涉及 GPU 的步骤需要 ssh 到远端执行')
  }
  if (quirks.length > 0) facts.quirks = quirks

  return facts
}

/** 跑一条探测命令，失败返回 null 而不是抛错。 */
async function probe(host: HostPort, command: string): Promise<string | null> {
  try {
    const r = await host.runCommand({ command, timeoutMs: 15_000 })
    if (r.exitCode !== 0) return null
    const out = r.stdout.trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

function clean(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^["']|["']$/g, ''))
    .find((l) => l !== '')
  return (line ?? '').slice(0, 120)
}
