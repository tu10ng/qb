/**
 * 清洗外部文本。
 *
 * 命令输出不保证是合法 UTF-8：Windows 上中文 locale 的程序输出 GBK，
 * 被按 UTF-8 解码后会产生孤立代理项（lone surrogate）。这种字符串
 * 存进 SQLite、经 JSON 序列化、写日志时都会在不同地方抛错，而且报错
 * 点离源头很远，很难查。所以在入口一次性清掉。
 */

const REPLACEMENT = '�'

/**
 * 把孤立代理项替换成 U+FFFD。
 *
 * 合法的代理对（emoji 等）保留不动。
 */
export function sanitizeText(input: string): string {
  let out = ''
  let changed = false

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)

    // 高位代理：必须后跟低位代理才合法
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i]! + input[i + 1]!
        i++
        continue
      }
      out += REPLACEMENT
      changed = true
      continue
    }

    // 落单的低位代理
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += REPLACEMENT
      changed = true
      continue
    }

    out += input[i]!
  }

  return changed ? out : input
}

/** 文本里是否含孤立代理项。 */
export function hasLoneSurrogate(input: string): boolean {
  return sanitizeText(input) !== input
}
