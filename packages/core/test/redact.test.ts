import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

describe('redact', () => {
  describe('具名凭据', () => {
    const cases: Array<[string, string, string]> = [
      ['OpenAI key', 'export OPENAI_API_KEY=sk-abc123def456ghi789jkl', 'sk-abc123def456ghi789jkl'],
      ['GitHub token', 'git clone https://ghp_1234567890abcdefghij@github.com/x/y', 'ghp_1234567890abcdefghij'],
      ['AWS key', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
      ['HuggingFace', 'huggingface-cli login --token hf_QwErTyUiOpAsDfGhJkLz', 'hf_QwErTyUiOpAsDfGhJkLz'],
    ]
    for (const [label, input, secret] of cases) {
      it(label, () => {
        const r = redact(input)
        expect(r.text).not.toContain(secret)
        expect(r.redacted).toBe(true)
      })
    }
  })

  it('key=value 形式', () => {
    const r = redact('mysql -u root --password=hunter2xyz')
    expect(r.text).not.toContain('hunter2xyz')
    expect(r.text).toContain('password=')
  })

  it('Authorization 头保留 scheme', () => {
    const r = redact('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxxx"')
    expect(r.text).not.toContain('eyJhbGciOiJIUzI1NiJ9xxxxx')
    expect(r.text).toContain('Bearer')
  })

  it('URL 内嵌凭据保留用户名', () => {
    const r = redact('git remote add origin https://alice:s3cr3tpass@git.corp.com/repo.git')
    expect(r.text).not.toContain('s3cr3tpass')
    expect(r.text).toContain('alice')
    expect(r.text).toContain('git.corp.com')
  })

  it('PEM 私钥块', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const r = redact(`here is the key:\n${pem}\ndone`)
    expect(r.text).not.toContain('MIIEowIBAAKCAQEA')
    expect(r.text).toContain('BEGIN RSA PRIVATE KEY')
    expect(r.text).toContain('done')
  })

  it('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    const r = redact(`token: ${jwt}`)
    expect(r.text).not.toContain(jwt)
  })

  describe('不误伤正常输出', () => {
    const cases = [
      'INFO 09:41:12 Started server process [12345]',
      'nvidia-smi: 8 x NVIDIA H800, CUDA Version: 12.4',
      'model loaded from /models/qwen2.5-72b in 132.5s',
      'GET /health 200 OK',
      'commit a1b2c3d4e5f6 Author: alice',
    ]
    for (const input of cases) {
      it(input.slice(0, 40), () => {
        const r = redact(input)
        expect(r.text).toBe(input)
        expect(r.redacted).toBe(false)
      })
    }
  })

  it('报告命中的规则标签', () => {
    const r = redact('key=sk-aaaaaaaaaaaaaaaaaa and password=bbbbbb')
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.redacted).toBe(true)
  })

  it('同一段文本中多处凭据全部脱敏', () => {
    const r = redact('sk-aaaaaaaaaaaaaaaaaa then sk-bbbbbbbbbbbbbbbbbb')
    expect(r.text).not.toContain('sk-aaaaaaaaaaaaaaaaaa')
    expect(r.text).not.toContain('sk-bbbbbbbbbbbbbbbbbb')
  })

  it('空字符串安全', () => {
    expect(redact('').text).toBe('')
    expect(redact('').redacted).toBe(false)
  })
})
