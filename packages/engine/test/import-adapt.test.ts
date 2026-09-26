import { describe, expect, it } from 'vitest'
import { ImportSchema, importMaterial } from '../src/agent/import.ts'
import { AdaptSchema, proposeAdapt } from '../src/agent/adapt.ts'
import { FakeLlm } from './fake-llm.ts'
import type { Param, Step } from '@qb/core'

const PERSONA = '你是 QB。'
const PROMPT = '素材：{{material}}\n环境：{{environment}}'

describe('importMaterial', () => {
  it('整理出步骤、参数、坑与缺口；source 进 sourceRef', async () => {
    const llm = new FakeLlm({
      params: [
        { name: 'DECODE_HOST', value: 'gpu-18', description: 'decode 机器' },
        { name: '中文参数', value: 'x' },
      ],
      steps: [
        { section: '1 检查', kind: 'command', title: '查驱动', command: 'nvidia-smi', source: 'nvidia-smi --query-gpu=driver_version' },
        { section: '2 启动', kind: 'command', title: '起 decode', command: 'ssh {{DECODE_HOST}} vllm serve', expect: 'Started server', source: 'ssh gpu-18 vllm serve' },
      ],
      lessons: [{ symptom: 'NCCL 卡初始化', fix: '比对驱动版本', stepIndex: 1 }],
      gaps: ['原文没说两台是否都要设 NCCL_SOCKET_IFNAME'],
    })

    const r = await importMaterial(llm, PERSONA, PROMPT, { material: '一堆文档', environments: [] })

    expect(r.params).toEqual([{ name: 'DECODE_HOST', value: 'gpu-18', description: 'decode 机器' }])
    expect(r.steps).toHaveLength(2) // 两章
    expect(r.steps[0]!.title).toBe('1 检查')
    expect(r.steps[0]!.children![0]!.title).toBe('查驱动')
    const decode = r.steps[1]!.children![0]!
    expect(decode.command).toBe('ssh {{DECODE_HOST}} vllm serve')
    expect(decode.sourceRef).toBe('ssh gpu-18 vllm serve')
    expect(r.lessons).toEqual([{ symptom: 'NCCL 卡初始化', fix: '比对驱动版本', stepIndex: 1 }])
    expect(r.gaps).toHaveLength(1)
  })

  it('一个步骤都没有时报错；坏步骤被丢弃并计数', async () => {
    await expect(importMaterial(new FakeLlm({ params: [], steps: [], lessons: [], gaps: [] }), PERSONA, PROMPT, { material: 'x', environments: [] })).rejects.toThrow()

    const llm = new FakeLlm({ params: [], steps: [null, { section: '', kind: 'command', title: '好的' }], lessons: [], gaps: [] })
    const r = await importMaterial(llm, PERSONA, PROMPT, { material: 'x', environments: [] })
    expect(r.steps).toHaveLength(1)
    expect(r.dropped).toBe(1)
  })

  it('给模型看的契约：参数名是大写、步骤必带标题', () => {
    const js = ImportSchema as unknown as { shape?: unknown }
    void js
    // 宽容校验之下，模型编出来的 kind 兜成 manual、坏参数名被清掉
    const parsed = ImportSchema.parse({
      params: [{ name: '小写名', value: 'x' }],
      steps: [{ section: '', kind: 'shell', title: 't' }],
      lessons: null,
      gaps: ['ok', null],
    })
    expect(parsed.steps[0]!.kind).toBe('manual')
    expect(parsed.lessons).toEqual([])
    expect(parsed.gaps).toEqual(['ok', ''])
  })
})

describe('proposeAdapt', () => {
  const params: Param[] = [
    { name: 'PREFILL_IP', value: '10.0.3.17', source: 'base', secret: false },
    { name: 'DECODE_HOST', value: 'gpu-18', source: 'base', secret: false },
  ]
  const step = (id: string, title: string, command: string | null): Step =>
    ({
      id,
      runbookId: 'rbk',
      parentId: null,
      orderKey: 'V',
      kind: 'command',
      title,
      whyMd: null,
      whySource: null,
      command,
      envId: null,
      expectation: null,
      probe: null,
      timeoutMs: null,
      expectedMinutes: null,
      status: 'pending',
      startedAt: null,
      endedAt: null,
      actualMs: null,
      delegateTaskId: null,
      rev: 0,
      lineageKey: null,
      origin: 'base',
      editedBy: null,
      sourceRef: null,
      statusNote: null,
    }) as Step
  const steps = [
    step('s0', '1 启动', null), // 章节标题
    step('s1', '检查驱动', 'nvidia-smi'),
    step('s2', '起 decode', 'ssh {{DECODE_HOST}} vllm serve'),
  ]

  it('渲染上下文（参数、渲染后的命令、说明）并解析提议', async () => {
    let seen = ''
    const llm = new FakeLlm((call) => {
      seen = `${call.system}\n${call.prompt}`
      return {
        paramChanges: [{ name: 'DECODE_HOST', to: 'gpu-22', reason: '换到 Y 集群' }],
        newParams: [{ name: 'NET_IF', value: 'eth0' }],
        stepEdits: [{ stepIndex: 2, command: 'ssh {{DECODE_HOST}} vllm serve --tensor-parallel-size 4' }],
        obsolete: [{ what: 'gpu-18 的 0、1 卡被占', reason: 'Y 集群全空' }],
        questions: ['prefill 的主机名是什么？'],
      }
    })

    const r = await proposeAdapt(llm, PERSONA, '参数：{{params}}\n步骤：{{steps}}\n坑：{{lessons}}\n说明：{{message}}', {
      message: '换到 Y 集群，网卡是 eth0',
      params,
      steps,
      lessons: [{ symptom: '网卡名错会连不上', fixMd: '设 NCCL_SOCKET_IFNAME', condition: null }],
    })

    expect(seen).toContain('PREFILL_IP = 10.0.3.17')
    expect(seen).toContain('ssh gpu-18 vllm serve') // 渲染后的命令
    expect(seen).toContain('换到 Y 集群，网卡是 eth0')
    expect(r.paramChanges).toEqual([{ name: 'DECODE_HOST', to: 'gpu-22', reason: '换到 Y 集群' }])
    expect(r.newParams[0]!.name).toBe('NET_IF')
    expect(r.stepEdits[0]!.stepIndex).toBe(2)
    expect(r.questions).toEqual(['prefill 的主机名是什么？'])
  })

  it('越界的 stepIndex 进 rejectedStepEdits，不静默消失', async () => {
    const llm = new FakeLlm({
      paramChanges: [],
      newParams: [],
      stepEdits: [{ stepIndex: 99, command: 'x' }, null],
      obsolete: [],
      questions: [],
    })
    const r = await proposeAdapt(llm, PERSONA, '{{params}}{{steps}}{{lessons}}{{message}}', {
      message: 'm',
      params,
      steps,
      lessons: [],
    })
    expect(r.stepEdits).toEqual([])
    expect(r.rejectedStepEdits).toEqual([{ stepIndex: 99, reason: '步骤序号对不上' }])
  })

  it('宽容校验：模型漏字段/给 null 不炸', () => {
    const parsed = AdaptSchema.parse({ paramChanges: null, stepEdits: [{ stepIndex: 'x' }] })
    expect(parsed.paramChanges).toEqual([])
    expect(parsed.stepEdits[0]!.stepIndex).toBe(-1)
  })
})
