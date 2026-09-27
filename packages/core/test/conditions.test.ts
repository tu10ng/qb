import { describe, expect, it } from 'vitest'
import { conditionFromParams, matchCondition, parseCondition } from '../src/conditions.ts'

const params = [
  { name: 'DECODE_HOST', value: 'gpu-18', source: 'origin' as const, secret: false },
  { name: 'NCCL_IFNAME', value: 'eth0', source: 'base' as const, secret: false },
  { name: 'API_KEY', value: 'sk-xxx', source: 'origin' as const, secret: true },
  { name: 'EMPTY', value: '', source: 'qb_guess' as const, secret: false },
]

const env = { os: 'Ubuntu 22.04', gpu: 'NVIDIA H800 x8' }

describe('parseCondition', () => {
  it('解析参数与环境项、中文包含', () => {
    const c = parseCondition('DECODE_HOST == gpu-18 AND 环境.GPU 包含 H800')
    expect(c).not.toBeNull()
    expect(c!.terms).toEqual([
      { name: 'decode_host', op: '==', value: 'gpu-18', isEnv: false },
      { name: 'gpu', op: 'contains', value: 'H800', isEnv: true },
    ])
  })

  it('自由文本（导入生成的步骤引用）解析不了 → null', () => {
    expect(parseCondition('步骤「启动 decode」')).toBeNull()
    expect(parseCondition('')).toBeNull()
    expect(parseCondition(null)).toBeNull()
  })

  it('非法名字（小写参数名、奇怪运算符）→ null', () => {
    expect(parseCondition('decode_host == gpu-18')).toBeNull()
    expect(parseCondition('DECODE_HOST ~= gpu-18')).toBeNull()
  })
})

describe('matchCondition', () => {
  it('全项成立', () => {
    expect(matchCondition(parseCondition('DECODE_HOST == gpu-18 AND NCCL_IFNAME != bond0'), params)).toBe(true)
  })

  it('一项不成立 → false（第二层）', () => {
    expect(matchCondition(parseCondition('DECODE_HOST == gpu-19'), params)).toBe(false)
  })

  it('引用缺值/不存在的参数 → null（无法判定）', () => {
    expect(matchCondition(parseCondition('EMPTY == x'), params)).toBeNull()
    expect(matchCondition(parseCondition('UNKNOWN == x'), params)).toBeNull()
  })

  it('环境事实：小写比对、contains 大小写不敏感', () => {
    expect(matchCondition(parseCondition('环境.GPU contains h800'), params, env)).toBe(true)
    expect(matchCondition(parseCondition('环境.OS contains Windows'), params, env)).toBe(false)
    expect(matchCondition(parseCondition('环境.GPU contains H800'), params, null)).toBeNull()
    expect(matchCondition(parseCondition('环境.PROXY == x'), params, env)).toBeNull()
  })

  it('无条件 → true（血缘锚定本身算匹配）', () => {
    expect(matchCondition(null, params)).toBe(true)
  })
})

describe('conditionFromParams', () => {
  it('渲染成 NAME == value，跳过缺值与 secret', () => {
    expect(conditionFromParams(params, ['DECODE_HOST', 'NCCL_IFNAME'])).toBe('DECODE_HOST == gpu-18 AND NCCL_IFNAME == eth0')
    expect(conditionFromParams(params, ['API_KEY', 'DECODE_HOST'])).toBe('DECODE_HOST == gpu-18')
    expect(conditionFromParams(params, ['EMPTY'])).toBeNull()
  })
})
