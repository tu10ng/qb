import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate, sanitizeText, tailCap } from '../src/sanitize.ts'

describe('sanitizeText', () => {
  it('普通文本原样返回', () => {
    const s = 'INFO Started server in 12.3s'
    expect(sanitizeText(s)).toBe(s)
  })

  it('中文原样返回', () => {
    const s = '输出不匹配预期，请检查版本'
    expect(sanitizeText(s)).toBe(s)
  })

  it('emoji（合法代理对）保留', () => {
    const s = '完成 ✅ 🎉 部署成功'
    expect(sanitizeText(s)).toBe(s)
  })

  it('替换孤立的低位代理', () => {
    // 这是 Windows GBK 输出被当成 UTF-8 解码后的真实产物
    const bad = '输出不匹\udc8d /0\\.11\\./'
    const clean = sanitizeText(bad)
    expect(hasLoneSurrogate(clean)).toBe(false)
    expect(clean).toContain('输出不匹')
    expect(clean).toContain('/0\\.11\\./')
  })

  it('替换孤立的高位代理', () => {
    const bad = 'abc\ud800def'
    const clean = sanitizeText(bad)
    expect(hasLoneSurrogate(clean)).toBe(false)
    expect(clean).toContain('abc')
    expect(clean).toContain('def')
  })

  it('高位代理在末尾', () => {
    expect(hasLoneSurrogate(sanitizeText('trailing\ud83d'))).toBe(false)
  })

  it('清洗后可以安全 JSON 序列化再解析', () => {
    // 这是这个函数存在的理由：非法代理项会让 JSON 往返产生不一致，
    // 进而在存库、发 WS、写日志时到处炸。
    const bad = 'cmd output \udc8d with \ud800 lone surrogates'
    const clean = sanitizeText(bad)
    const round = JSON.parse(JSON.stringify({ text: clean })) as { text: string }
    expect(round.text).toBe(clean)
  })

  it('清洗后可以安全编码为 UTF-8', () => {
    const bad = '输出不匹\udc8d'
    const clean = sanitizeText(bad)
    expect(() => Buffer.from(clean, 'utf8').toString('utf8')).not.toThrow()
    expect(Buffer.from(clean, 'utf8').toString('utf8')).toBe(clean)
  })

  it('空字符串安全', () => {
    expect(sanitizeText('')).toBe('')
  })

  it('连续多个孤立代理', () => {
    expect(hasLoneSurrogate(sanitizeText('\udc8d\udc8e\ud800\ud801'))).toBe(false)
  })
})

describe('hasLoneSurrogate', () => {
  it('识别干净文本', () => {
    expect(hasLoneSurrogate('正常输出 🎉')).toBe(false)
  })

  it('识别污染文本', () => {
    expect(hasLoneSurrogate('bad \udc8d')).toBe(true)
  })
})

describe('tailCap', () => {
  it('没超限原样返回', () => {
    expect(tailCap('NCCL WARN: No route to host', 100)).toEqual({ text: 'NCCL WARN: No route to host', truncated: false })
  })

  it('超限时保留尾部并注明截断了多少', () => {
    const input = 'a'.repeat(300)
    const { text, truncated } = tailCap(input, 100)
    expect(truncated).toBe(true)
    expect(text).toMatch(/^……（前面 200 字符已截断）\n/)
    expect(text.endsWith('a'.repeat(100))).toBe(true)
  })

  it('正好等于上限时不截断', () => {
    expect(tailCap('x'.repeat(50), 50).truncated).toBe(false)
  })
})
