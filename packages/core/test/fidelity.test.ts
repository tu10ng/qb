import { describe, expect, it } from 'vitest'
import { checkFidelity, commandLinesOf, normLine } from '../src/fidelity.ts'
import type { Param } from '../src/schema.ts'

const SOURCE = `# 手册

机器是 gpu-17，注意下:

    nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u
    CUDA_VISIBLE_DEVICES=2,3,4,5,6,7 nohup vllm serve /data/models/Qwen2.5-72B --port 8200 > decode.log 2>&1 &
    curl -s http://10.0.3.17:10001/v1/models

普通段落里的 \`ls\` 不缩进。
`

const params: Param[] = [
  { name: 'DECODE_GPUS', value: '2,3,4,5,6,7', source: 'origin', secret: false },
  { name: 'MODEL_PATH', value: '/data/models/Qwen2.5-72B', source: 'origin', secret: false },
  { name: 'DECODE_PORT', value: '8200', source: 'origin', secret: false },
  { name: 'PROXY_PORT', value: '10001', source: 'origin', secret: false },
  { name: 'PREFILL_IP', value: '10.0.3.17', source: 'origin', secret: false },
]

describe('commandLinesOf', () => {
  it('认出缩进行与命令起始词；去重、跳过注释', () => {
    const lines = commandLinesOf(SOURCE)
    expect(lines).toContain('nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u')
    expect(lines).toContain(
      'CUDA_VISIBLE_DEVICES=2,3,4,5,6,7 nohup vllm serve /data/models/Qwen2.5-72B --port 8200 > decode.log 2>&1 &',
    )
    expect(lines).toContain('curl -s http://10.0.3.17:10001/v1/models')
    // "普通段落" 一行的第一个词不是命令起始词，也不缩进 → 不算
    expect(lines.some((l) => l.startsWith('普通段落'))).toBe(false)
  })
})

describe('normLine', () => {
  it('连续空白压成一个空格', () => {
    expect(normLine('a   b\t\tc\n\nd')).toBe('a b c d')
  })
})

describe('checkFidelity', () => {
  it('参数替换回去后逐字命中素材 → verbatim', () => {
    const r = checkFidelity(
      [
        'nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u',
        'CUDA_VISIBLE_DEVICES={{DECODE_GPUS}} nohup vllm serve {{MODEL_PATH}} --port {{DECODE_PORT}} > decode.log 2>&1 &',
      ],
      SOURCE,
      params,
    )
    expect(r.items.every((i) => i.verbatim)).toBe(true)
    expect(r.uncovered).toContain('curl -s http://10.0.3.17:10001/v1/models')
  })

  it('QB 改写了命令 → 标出来并给出素材里最接近的一行', () => {
    const r = checkFidelity(['CUDA_VISIBLE_DEVICES={{DECODE_GPUS}} nohup vllm serve {{MODEL_PATH}} --port 9999 > decode.log 2>&1 &'], SOURCE, params)
    const item = r.items[0]!
    expect(item.verbatim).toBe(false)
    expect(item.closest).toContain('--port 8200')
  })

  it('缺参数的步骤标记为没法验证，而不是误报改写', () => {
    const r = checkFidelity(['vllm serve {{UNKNOWN}}'], SOURCE, params)
    expect(r.items[0]!.unverified).toBe(true)
    expect(r.items[0]!.verbatim).toBe(false)
  })

  it('渲染值是素材行的超集也算用过（命令前多敲了 export 前缀的场景）', () => {
    const r = checkFidelity(
      ['export NCCL_IB_DISABLE=0 && curl -s http://10.0.3.17:10001/v1/models'],
      SOURCE,
      params,
    )
    expect(r.uncovered).not.toContain('curl -s http://10.0.3.17:10001/v1/models')
  })
})
