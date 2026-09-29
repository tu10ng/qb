import { describe, expect, it } from 'vitest'
import {
  literalSuggestions,
  machineName,
  machineParam,
  othersWithValue,
  paramRefs,
  parseMachineLine,
  parseMachines,
  pickLines,
  redactSecrets,
  render,
  sameValueGroups,
  segmentTemplate,
  toParamName,
} from '../src/params.ts'
import { Param as ParamSchema, type Param } from '../src/schema.ts'

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

  it('端口不像端口的上下文不认：ulimit -n 1024、版本号 1024.5', () => {
    const s = literalSuggestions(['ulimit -n 1024', 'ulimit -n 1024', 'ulimit -n 1024'])
    expect(s.map((x) => x.value)).not.toContain('1024')
    // 冒号/空格后跟的 4-5 位数仍是端口（minCount=2，各出现两次）
    const ok = literalSuggestions(['--port 8200', 'ss -tlnp | grep 8200', 'curl :10001', 'curl :10001/v1'])
    expect(ok.map((x) => x.value)).toContain('8200')
    expect(ok.map((x) => x.value)).toContain('10001')
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

// ── 中文参数名、字段、secret、机器行 ───────────────────────────

describe('参数名', () => {
  it('中文名、中英混合都认；纯小写英文不认（{{name}} 多半是 jinja 模板）', () => {
    expect(paramRefs('docker exec -it {{容器名}} bash; ssh {{机器195}} {{NAME_2}} {{name}} {{ 容器名 }}')).toEqual(['容器名', '机器195', 'NAME_2'])
    expect(ParamSchema.safeParse({ name: '容器名', value: 'x', source: 'mine' }).success).toBe(true)
    expect(ParamSchema.safeParse({ name: 'decode_host', value: 'x', source: 'mine' }).success).toBe(false)
    expect(ParamSchema.safeParse({ name: '2号卡', value: 'x', source: 'mine' }).success).toBe(false)
  })

  it('toParamName：中文照留，英文转大写，数字开头补前缀', () => {
    expect(toParamName('容器 名')).toBe('容器_名')
    expect(toParamName('gpu-17')).toBe('GPU_17')
    expect(toParamName('195')).toBe('P_195')
  })
})

describe('字段', () => {
  const machine: Param = {
    name: '机器195',
    value: '10.9.8.195',
    valueLabel: 'IP',
    source: 'mine',
    secret: false,
    fields: [
      { key: '用户', value: 'root', secret: false },
      { key: '密码', value: 'Fake-Pass-123', secret: true },
    ],
  }

  it('{{名字}} 是主值，{{名字.字段}} 是字段，{{名字.IP}} 也是主值', () => {
    expect(render('ssh {{机器195.用户}}@{{机器195}} # {{机器195.IP}}', [machine]).text).toBe('ssh root@10.9.8.195 # 10.9.8.195')
  })

  it('没有这个字段算未声明，不渲染', () => {
    const r = render('ssh -p {{机器195.端口}} {{机器195}}', [machine])
    expect(r.undeclared).toEqual(['机器195.端口'])
    expect(r.text).toBe('ssh -p {{机器195.端口}} 10.9.8.195')
  })

  it('切段时标出 secret，界面据此打码', () => {
    const segs = segmentTemplate('sshpass -p {{机器195.密码}} ssh {{机器195}}', [machine])
    const secret = segs.find((s) => s.kind === 'param' && s.field === '密码')
    expect(secret).toMatchObject({ kind: 'param', secret: true, value: 'Fake-Pass-123' })
  })

  it('redactSecrets 把 secret 的值换成 ***', () => {
    expect(redactSecrets('login ok with Fake-Pass-123 twice Fake-Pass-123', [machine])).toEqual({ text: 'login ok with *** twice ***', hits: 2 })
    expect(redactSecrets('nothing here', [machine]).hits).toBe(0)
  })
})

describe('机器行', () => {
  it('"IP  用户  密码" 一行（用户贴的原样）', () => {
    expect(parseMachineLine('10.9.8.195    root    Fake@123')).toEqual({ host: '10.9.8.195', port: null, user: 'root', password: 'Fake@123' })
  })

  it('user@host、带端口、ssh 命令、带标签的写法', () => {
    expect(parseMachineLine('root@10.0.3.17 Fake@123')).toEqual({ host: '10.0.3.17', port: null, user: 'root', password: 'Fake@123' })
    expect(parseMachineLine('ssh root@gpu-18 -p 2222')).toEqual({ host: 'gpu-18', port: '2222', user: 'root', password: null })
    expect(parseMachineLine('10.0.3.17:2222 admin')).toEqual({ host: '10.0.3.17', port: '2222', user: 'admin', password: null })
    expect(parseMachineLine('IP：10.0.3.18 用户：root 密码：Fake@1')).toEqual({ host: '10.0.3.18', port: null, user: 'root', password: 'Fake@1' })
    expect(parseMachineLine('195机器 10.0.3.19 root pw')).toEqual({ host: '10.0.3.19', port: null, user: 'root', password: 'pw' })
  })

  it('认不出主机就不是机器行', () => {
    expect(parseMachineLine('docker images')).toBeNull()
    expect(parseMachineLine('')).toBeNull()
    expect(parseMachines('10.0.3.1 root a\nfoo bar\n10.0.3.2 root b')).toHaveLength(2)
  })

  it('一台机器是一个参数：主值是 IP，密码是 secret；名字按 IP 末段', () => {
    const m = parseMachineLine('10.9.8.195 root Fake@123')!
    const p = machineParam(m, machineName(m.host, new Set()))
    expect(p).toMatchObject({ name: '机器195', value: '10.9.8.195', valueLabel: 'IP' })
    expect(p.fields).toEqual([
      { key: '用户', value: 'root', secret: false },
      { key: '密码', value: 'Fake@123', secret: true },
    ])
    expect(machineName('10.9.8.195', new Set(['机器195']))).toBe('机器195_2')
    expect(machineName('gpu-18', new Set())).toBe('GPU_18')
  })
})

describe('pickLines', () => {
  it('取选中的几行（顺序反了也行、越界截断）', () => {
    expect(pickLines('a\nb\nc\nd', 2, 3)).toBe('b\nc')
    expect(pickLines('a\nb\nc', 3, 2)).toBe('b\nc')
    expect(pickLines('a\nb', 1, 9)).toBe('a\nb')
  })
})
