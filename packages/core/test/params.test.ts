import { describe, expect, it } from 'vitest'
import {
  literalSuggestions,
  othersWithValue,
  paramRefs,
  render,
  sameValueGroups,
  toParamName,
} from '../src/params.ts'
import type { Param } from '../src/schema.ts'

const p = (name: string, value: string, source: Param['source'] = 'origin'): Param => ({
  name,
  value,
  source,
  secret: false,
})

describe('paramRefs', () => {
  it('按出现顺序去重', () => {
    expect(paramRefs('{{A}} x {{B}} {{A}}')).toEqual(['A', 'B'])
  })

  it('不匹配 Go 模板与大小写不符的名字', () => {
    expect(paramRefs('{{.Field}} {{name}} {{NAME_2}}')).toEqual(['NAME_2'])
  })
})

describe('render', () => {
  it('替换已声明的参数', () => {
    expect(render('curl http://{{HOST}}:{{PORT}}/v1', [p('HOST', '10.0.3.17'), p('PORT', '10001')])).toEqual({
      text: 'curl http://10.0.3.17:10001/v1',
      missing: [],
      undeclared: [],
    })
  })

  it('值为空 → missing，引用原样保留（看得出缺哪个）', () => {
    const r = render('ssh {{DECODE_HOST}}', [p('DECODE_HOST', '')])
    expect(r.text).toBe('ssh {{DECODE_HOST}}')
    expect(r.missing).toEqual(['DECODE_HOST'])
  })

  it('未声明 → undeclared，不替换', () => {
    const r = render('ssh {{TYPO_NAME}}', [p('OTHER', 'x')])
    expect(r.text).toBe('ssh {{TYPO_NAME}}')
    expect(r.undeclared).toEqual(['TYPO_NAME'])
  })
})

describe('literalSuggestions', () => {
  const cmds = [
    'curl http://10.0.3.17:10001/v1/models',
    'ssh gpu-18',
    'nohup vllm serve --port 8200 > decode.log &',
    'curl http://10.0.3.17:8100/health',
    'tail -f decode.log',
    'ssh gpu-18 hostname',
    'python3 bench.py --host 10.0.3.17 --port 10001',
    'ls /data/models/Qwen2.5-72B',
    'du -sh /data/models/Qwen2.5-72B',
  ]

  it('IP 出现一次也建议；主机名/端口/路径要重复出现', () => {
    const s = literalSuggestions(cmds)
    const values = s.map((x) => x.value)
    expect(values).toContain('10.0.3.17')
    expect(values).toContain('gpu-18')
    expect(values).toContain('10001') // 出现两次
    expect(values).toContain('/data/models/Qwen2.5-72B')
    // 8200、8100 只出现一次（端口规则 minCount=2），不该进建议
    expect(values).not.toContain('8200')
    expect(values).not.toContain('8100')
  })

  it('出现次数多的排前面', () => {
    const s = literalSuggestions(cmds)
    const ip = s.find((x) => x.value === '10.0.3.17')!
    expect(ip.count).toBe(3)
    expect(s[0]!.count).toBeGreaterThanOrEqual(ip.count)
  })

  it('给得出合法的参数名', () => {
    const s = literalSuggestions(['ssh gpu-18', 'gpu-18 hostname'])
    expect(s.find((x) => x.value === 'gpu-18')!.suggestedName).toBe('GPU_18')
    expect(toParamName('prefill host!')).toBe('PREFILL_HOST')
    expect(toParamName('---')).toBe('PARAM')
  })
})

describe('同值联动', () => {
  it('值相同的参数分组', () => {
    const groups = sameValueGroups([p('PREFILL_IP', '10.0.3.17'), p('PROXY_IP', '10.0.3.17'), p('DECODE_IP', '10.0.3.18')])
    expect(groups).toEqual([{ value: '10.0.3.17', names: ['PREFILL_IP', 'PROXY_IP'] }])
  })

  it('改一个值时给出同值的其余参数', () => {
    expect(othersWithValue([p('A', 'x'), p('B', 'x'), p('C', 'y')], 'A', 'x')).toEqual(['B'])
    expect(othersWithValue([p('A', ''), p('B', '')], 'A', '')).toEqual([]) // 空值不算
  })
})
