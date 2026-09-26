import { describe, expect, it } from 'vitest'
import { matchBlocks, splitTranscript } from '../src/transcript.ts'
import type { Param } from '../src/schema.ts'

const LOG = `Welcome to gpu-17
Last login: Sun Sep 27 10:00:00 2026
[root@gpu-17 ~]# nvidia-smi --query-gpu=memory.used --format=csv
memory.used [MiB]
1024
[root@gpu-17 ~]# CUDA_VISIBLE_DEVICES=2,3,4,5,6,7 vllm serve /data/models/Qwen2.5-72B --port 8200
INFO Started server process
ERROR NCCL No route to host
[root@gpu-17 ~]# free -g | head -2
              total        used
tu10ng@gpu-18:~$ ls /data/models
Qwen2.5-72B
`

describe('splitTranscript', () => {
  it('按提示符切成命令+输出；SSH 横幅丢弃', () => {
    const blocks = splitTranscript(LOG)
    expect(blocks.map((b) => b.command)).toEqual([
      'nvidia-smi --query-gpu=memory.used --format=csv',
      'CUDA_VISIBLE_DEVICES=2,3,4,5,6,7 vllm serve /data/models/Qwen2.5-72B --port 8200',
      'free -g | head -2',
      'ls /data/models',
    ])
    expect(blocks[0]!.output).toBe('memory.used [MiB]\n1024')
    expect(blocks[1]!.output).toBe('INFO Started server process\nERROR NCCL No route to host')
  })

  it('反斜杠续行并入同一条命令', () => {
    const blocks = splitTranscript('$ echo a \\\n> b\nc\n$ ls')
    expect(blocks[0]!.command).toBe('echo a b')
    expect(blocks[0]!.output).toBe('c')
    expect(blocks).toHaveLength(2)
  })

  it('空提示符行不产生块', () => {
    expect(splitTranscript('$ \n$\n')).toEqual([])
  })
})

describe('matchBlocks', () => {
  const params: Param[] = [
    { name: 'DECODE_GPUS', value: '2,3,4,5,6,7', source: 'origin', secret: false },
    { name: 'MODEL_PATH', value: '/data/models/Qwen2.5-72B', source: 'origin', secret: false },
  ]
  const steps = [
    { id: 's1', command: 'nvidia-smi --query-gpu=memory.used --format=csv' },
    { id: 's2', command: 'CUDA_VISIBLE_DEVICES={{DECODE_GPUS}} vllm serve {{MODEL_PATH}} --port 8200' },
    { id: 's3', command: null },
  ]

  it('精确命中与模板渲染命中', () => {
    const blocks = splitTranscript(LOG)
    const m = matchBlocks(blocks, steps, params)
    expect(m.find((x) => x.stepId === 's1')?.exact).toBe(true)
    expect(m.find((x) => x.stepId === 's2')?.exact).toBe(true)
  })

  it('runbook 之外的命令 stepId=null，不算失败', () => {
    const m = matchBlocks(splitTranscript(LOG), steps, params)
    expect(m.find((x) => x.blockIndex === 2)?.stepId).toBeNull()
    expect(m.find((x) => x.blockIndex === 3)?.stepId).toBeNull()
  })

  it('步骤命令是块命令的子串时也算命中（终端里多敲了前缀）', () => {
    const m = matchBlocks(
      [
        { command: 'CUDA_VISIBLE_DEVICES=0,1 nohup vllm serve /m --port 8100', output: '' },
        { command: 'vllm serve /m --port 8100', output: '' },
      ],
      [{ id: 's', command: 'vllm serve /m --port 8100' }],
      [],
    )
    expect(m.every((x) => x.stepId === 's')).toBe(true)
    expect(m[1]!.exact).toBe(true)
  })

  it('两条命令互为前缀时归给更长（更具体）的那步，短命令也认（≥6 字符）', () => {
    const m = matchBlocks(
      [{ command: 'vllm serve /m --port 8100 --extra-flag', output: '' }],
      [
        { id: 'short', command: 'vllm serve /m' },
        { id: 'long', command: 'vllm serve /m --port 8100' },
      ],
      [],
    )
    expect(m[0]!.stepId).toBe('long')

    const short = matchBlocks([{ command: 'free -g', output: '' }], [{ id: 'fg', command: 'free -g' }], [])
    expect(short[0]!.stepId).toBe('fg')
  })
})
