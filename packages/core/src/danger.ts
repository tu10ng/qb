export type DangerLevel = 'safe' | 'caution' | 'destructive'

export interface DangerVerdict {
  level: DangerLevel
  /** 命中的模式描述，用于在 UI 上说明"为什么给你亮红框"。 */
  matched: string[]
}

interface Pattern {
  re: RegExp
  label: string
  level: Exclude<DangerLevel, 'safe'>
}

/**
 * 破坏性命令模式。
 *
 * 产品宪法第 3 条要求不当保姆：这里不拦截、不弹窗，只判级。
 * destructive 让前端加红框与内联"确认运行"开关，caution 只做视觉提示。
 */
const PATTERNS: Pattern[] = [
  // 文件系统
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]/, label: 'rm -rf', level: 'destructive' },
  { re: /\bmkfs(\.\w+)?\b/, label: 'mkfs 格式化', level: 'destructive' },
  { re: /\bdd\s+[^|]*\bof=\/dev\//, label: 'dd 写入块设备', level: 'destructive' },
  { re: /\bshred\b/, label: 'shred', level: 'destructive' },
  { re: />\s*\/dev\/[sh]d[a-z]/, label: '重定向写入块设备', level: 'destructive' },
  { re: /\bchmod\s+(-[a-zA-Z]*\s+)*-?[rR]\s+777\b|\bchmod\s+777\s+\//, label: 'chmod 777 递归', level: 'caution' },
  { re: /\bchown\s+-[a-zA-Z]*[rR]/, label: 'chown 递归', level: 'caution' },

  // 版本控制
  { re: /\bgit\s+push\b[^|;&]*(--force\b|-f\b)/, label: 'git push --force', level: 'destructive' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard', level: 'caution' },
  { re: /\bgit\s+clean\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[fdx]/, label: 'git clean -fd', level: 'caution' },

  // 数据库
  { re: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, label: 'DROP', level: 'destructive' },
  { re: /\bTRUNCATE\s+TABLE\b/i, label: 'TRUNCATE', level: 'destructive' },
  { re: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, label: '无 WHERE 的 DELETE', level: 'destructive' },

  // 编排与容器
  { re: /\bkubectl\s+delete\b/, label: 'kubectl delete', level: 'destructive' },
  { re: /\bhelm\s+(delete|uninstall)\b/, label: 'helm uninstall', level: 'destructive' },
  { re: /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)\b/, label: 'docker 清理', level: 'caution' },
  { re: /\bterraform\s+destroy\b/, label: 'terraform destroy', level: 'destructive' },

  // 主机与进程
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, label: '关机/重启', level: 'destructive' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall5\b/, label: '杀死所有进程', level: 'destructive' },
  { re: /\bpkill\s+-9\b/, label: 'pkill -9', level: 'caution' },

  // 包管理
  { re: /\b(apt|apt-get|yum|dnf)\s+(remove|purge|autoremove)\b/, label: '卸载系统包', level: 'caution' },
  { re: /\bpip\s+uninstall\b(?![\s\S]*-y\b)/, label: 'pip uninstall', level: 'caution' },

  // 管道到 shell
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, label: 'curl | sh', level: 'caution' },
  { re: /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, label: 'wget | sh', level: 'caution' },
]

/**
 * 判定一条命令的危险等级。
 *
 * 只做静态模式匹配，不求完备——目标是覆盖常见的"手滑就完蛋"，
 * 而不是构建一个安全沙箱（那是 dsh 的 SAFETY.md 明确不提供的东西）。
 */
export function assessDanger(command: string): DangerVerdict {
  const matched: string[] = []
  let level: DangerLevel = 'safe'

  for (const p of PATTERNS) {
    if (p.re.test(command)) {
      matched.push(p.label)
      if (p.level === 'destructive') {
        level = 'destructive'
      } else if (level === 'safe') {
        level = 'caution'
      }
    }
  }

  return { level, matched }
}
