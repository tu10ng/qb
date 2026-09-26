export interface RedactionRule {
  re: RegExp
  label: string
  /** 替换函数：保留足够的形状让人认出这是什么，但不泄露内容。 */
  replace: (match: string, ...groups: string[]) => string
}

const MASK = '***'

/**
 * 内置脱敏规则。
 *
 * 命令输出在同步到团队服务之前必须过这一层。宁可多打码，
 * 也不能把凭据同步出去——泄露一次就再也收不回来了。
 */
const BUILTIN_RULES: RedactionRule[] = [
  // 具名 API key
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, label: 'OpenAI key', replace: () => `sk-${MASK}` },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, label: 'GitHub token', replace: (m) => `${m.slice(0, 4)}${MASK}` },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key', replace: () => `AKIA${MASK}` },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: 'Slack token', replace: (m) => `${m.slice(0, 5)}${MASK}` },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g, label: 'GitLab token', replace: () => `glpat-${MASK}` },
  { re: /\bhf_[A-Za-z0-9]{16,}/g, label: 'HuggingFace token', replace: () => `hf_${MASK}` },

  // key=value 形式
  {
    re: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*(["']?)([^\s"'&;|]{3,})\2/gi,
    label: 'key=value 凭据',
    replace: (_m, key: string, quote: string) => `${key}=${quote}${MASK}${quote}`,
  },

  // HTTP 头
  { re: /\bAuthorization\s*:\s*(Bearer|Basic|Token)\s+\S+/gi, label: 'Authorization 头', replace: (_m, scheme: string) => `Authorization: ${scheme} ${MASK}` },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, label: 'Bearer token', replace: () => `Bearer ${MASK}` },

  // URL 里的凭据
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]+):([^@/\s]+)@/gi,
    label: 'URL 内嵌凭据',
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`,
  },

  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'JWT', replace: () => `eyJ${MASK}` },

  // PEM 块（含 SSH 私钥）
  {
    re: /-----BEGIN ([A-Z ]*?)(PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END \1\2-----/g,
    label: 'PEM 块',
    replace: (_m, prefix: string, kind: string) => `-----BEGIN ${prefix}${kind}-----\n${MASK}\n-----END ${prefix}${kind}-----`,
  },
]

export interface RedactionResult {
  text: string
  /** 命中的规则标签去重，用于在 UI 上说明"这里打过码"。 */
  hits: string[]
  redacted: boolean
}

/**
 * 对一段文本做脱敏。
 *
 * @param text 原始输出
 * @param extraRules 团队自定义规则，追加在内置规则之后
 */
export function redact(text: string, extraRules: RedactionRule[] = []): RedactionResult {
  const hits = new Set<string>()
  let out = text

  for (const rule of [...BUILTIN_RULES, ...extraRules]) {
    // 每条规则用自己的 lastIndex，避免 /g 正则跨调用串味。
    const re = new RegExp(rule.re.source, rule.re.flags)
    out = out.replace(re, (...args: unknown[]) => {
      hits.add(rule.label)
      const match = args[0] as string
      const groups = args.slice(1, -2) as string[]
      return rule.replace(match, ...groups)
    })
  }

  return { text: out, hits: [...hits], redacted: hits.size > 0 }
}
