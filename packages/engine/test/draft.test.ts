import { describe, expect, it } from 'vitest'
import { draftRunbook, type DraftContext } from '../src/agent/draft.ts'
import type { Completion, CompletionRequest, HostPort } from '../src/dsh/port.ts'
import { FakeHost } from './fake-host.ts'

/** 返回预设结构化输出的 host。 */
function hostReturning(structured: unknown, text = ''): HostPort {
  return hostWith(async () => ({
    text,
    ...(structured !== undefined ? { structured } : {}),
    model: 'test-model',
  }))
}

/** 用自定义 complete 实现构造 host。 */
function hostWith(complete: (req: CompletionRequest) => Promise<Completion>): HostPort {
  const base = new FakeHost()
  return {
    info: base.info,
    runCommand: base.runCommand.bind(base),
    startCommand: base.startCommand.bind(base),
    schedule: base.schedule.bind(base),
    complete,
  }
}

const PERSONA = '你是 QB。'
const TEMPLATE = '任务：{{title}}\n{{brief}}\n环境：{{environment}}\n知识：{{knowledge}}'

const ctx: DraftContext = {
  task: {
    title: '部署 vLLM',
    briefMd: 'PD 分离',
    expectedMinutes: 120,
    definitionOfDone: 'proxy 能转发',
  },
  environments: [],
  skills: [],
  lessons: [],
}

describe('draftRunbook', () => {
  it('解析合法的模型输出', async () => {
    const host = hostReturning({
      assumptions: [{ key: '集群', value: 'X' }],
      steps: [
        {
          section: '1 准备',
          kind: 'command',
          title: '检查 GPU',
          why: '显存不够会白起',
          command: 'nvidia-smi',
          expect: 'memory.used',
          minutes: 0.2,
        },
      ],
    })

    const result = await draftRunbook(host, PERSONA, TEMPLATE, ctx)

    expect(result.assumptions).toEqual([{ key: '集群', value: 'X', editedByUser: false }])
    // section 还原成章节节点
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.kind).toBe('note')
    expect(result.steps[0]!.title).toBe('1 准备')
    expect(result.steps[0]!.children).toHaveLength(1)

    const step = result.steps[0]!.children![0]!
    expect(step.command).toBe('nvidia-smi')
    expect(step.whyMd).toBe('显存不够会白起')
    expect(step.expectation).toEqual({
      kind: 'contains',
      text: 'memory.used',
      caseSensitive: true,
    })
    // 超时由 minutes 推导（3 倍，下限 30 秒），不让模型自己算
    expect(step.timeoutMs).toBe(36_000)
    expect(result.model).toBe('test-model')
  })

  describe('section 还原成树', () => {
    it('多个 section 各自成章节，顺序保持', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [
          { section: '1 准备', kind: 'command', title: 'a' },
          { section: '1 准备', kind: 'command', title: 'b' },
          { section: '2 启动', kind: 'command', title: 'c' },
          { section: '3 验证', kind: 'check', title: 'd' },
        ],
      })

      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['1 准备', '2 启动', '3 验证'])
      expect(r.steps[0]!.children!.map((c) => c.title)).toEqual(['a', 'b'])
      expect(r.steps[1]!.children!.map((c) => c.title)).toEqual(['c'])
      expect(r.steps[2]!.children!.map((c) => c.title)).toEqual(['d'])
    })

    it('没有 section 的步骤放顶层', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: '单步任务', command: 'ls' }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps).toHaveLength(1)
      expect(r.steps[0]!.title).toBe('单步任务')
      expect(r.steps[0]!.children).toBeUndefined()
    })

    it('同名 section 不连续时各自成节——尊重模型给的顺序', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [
          { section: 'A', kind: 'command', title: 'a1' },
          { section: 'B', kind: 'command', title: 'b1' },
          { section: 'A', kind: 'command', title: 'a2' },
        ],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['A', 'B', 'A'])
    })
  })

  describe('预期与探针的组装', () => {
    it('命令类步骤：expect 当成输出要包含的字样', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', expect: 'Started server' }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({
        kind: 'contains',
        text: 'Started server',
        caseSensitive: true,
      })
    })

    it('人工类步骤：expect 当成人工判断标准', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [
          { kind: 'manual', title: '压测', expect: 'QPS 不低于单体部署' },
          { kind: 'decision', title: '选配比', expect: '和 PL 确认过' },
        ],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({
        kind: 'manual',
        description: 'QPS 不低于单体部署',
      })
      expect(r.steps[1]!.expectation).toEqual({ kind: 'manual', description: '和 PL 确认过' })
    })

    describe('wait 步骤的 expect 识别成就绪探针', () => {
      it('URL', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'wait', title: '等就绪', expect: 'http://gpu-17:8100/health' }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({
          kind: 'http',
          url: 'http://gpu-17:8100/health',
          expectStatus: 200,
        })
        expect(r.steps[0]!.expectation).toBeUndefined()
      })

      it('host:port', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'wait', title: '等端口', expect: 'gpu-17:8200' }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({ kind: 'port', host: 'gpu-17', port: 8200 })
      })

      it('只给端口号时默认本机', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'wait', title: '等端口', expect: '8200' }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({ kind: 'port', host: '127.0.0.1', port: 8200 })
      })

      it('不像地址的文本退化成输出匹配', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'wait', title: '等加载', expect: 'Loading weights complete' }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toBeUndefined()
        expect(r.steps[0]!.expectation).toEqual({
          kind: 'contains',
          text: 'Loading weights complete',
          caseSensitive: true,
        })
      })
    })

    describe('超时由耗时推导', () => {
      it('取 3 倍', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'command', title: 'x', minutes: 8 }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(8 * 60_000 * 3)
      })

      it('短任务有 30 秒下限——命令启动本身要时间', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'command', title: 'x', minutes: 0.05 }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(30_000)
      })

      it('没给耗时时用兜底值', async () => {
        const host = hostReturning({
          assumptions: [],
          steps: [{ kind: 'command', title: 'x' }],
        })
        const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(120_000)
      })
    })
  })

  describe('容错', () => {
    it('模型没返回结构化结果时报错并带上它说了什么', async () => {
      const host = hostReturning(undefined, '我需要更多信息才能起草')
      await expect(draftRunbook(host, PERSONA, TEMPLATE, ctx)).rejects.toThrow(/我需要更多信息/)
    })

    it('步骤为空时报错', async () => {
      const host = hostReturning({ assumptions: [], steps: [] })
      await expect(draftRunbook(host, PERSONA, TEMPLATE, ctx)).rejects.toThrow()
    })

    it('空文本的预期被丢弃——它永远为真，等于没有预期', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', expect: '   ' }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toBeUndefined()
      expect(r.steps[0]!.title).toBe('x') // 步骤本身保留
    })

    it('个别步骤不合格时丢掉它，保留其余', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [
          { kind: 'command', title: '好的', command: 'ls' },
          { kind: 'not-a-kind', title: '坏的' },
          { kind: 'command', title: '也好的' },
        ],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['好的', '也好的'])
    })

    it('所有步骤都不合格时明确报错', async () => {
      const host = hostReturning({ assumptions: [], steps: [{ kind: 'bad', title: 'x' }] })
      await expect(draftRunbook(host, PERSONA, TEMPLATE, ctx)).rejects.toThrow(/不合格式/)
    })

    it('缺 assumptions 字段时默认空数组', async () => {
      const host = hostReturning({ steps: [{ kind: 'command', title: 'x' }] })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.assumptions).toEqual([])
    })
  })

  describe('提示词渲染', () => {
    it('把任务、环境、知识都填进模板', async () => {
      let seen = ''
      const host = hostWith(async (req) => {
        seen = req.messages.map((m) => m.content).join('\n')
        return {
          text: '',
          structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
          model: 'm',
        }
      })

      await draftRunbook(host, PERSONA, TEMPLATE, {
        task: {
          title: '部署 vLLM',
          briefMd: 'PD 分离部署',
          expectedMinutes: null,
          definitionOfDone: null,
        },
        environments: [
          {
            id: 'e1',
            name: 'gpu-17',
            facts: { os: 'Ubuntu 22.04', gpu: '8×H800', cuda: '12.4', quirks: ['走代理'] },
            ownerId: null,
            collectedAt: null,
            createdAt: 0,
          },
        ],
        skills: [{ name: 'pd-deploy', description: 'PD 分离部署套路', appliesWhen: 'vLLM 0.11+' }],
        lessons: [
          {
            symptom: 'NCCL 卡在初始化',
            fixMd: '设 NCCL_IB_DISABLE=1',
            condition: '版本不一致时',
            nextTimeMd: '启动前先比对版本',
          },
        ],
      })

      for (const fragment of [
        '部署 vLLM',
        'PD 分离部署',
        'gpu-17',
        '8×H800',
        '走代理',
        'pd-deploy',
        'NCCL 卡在初始化',
        'NCCL_IB_DISABLE=1',
        '启动前先比对版本',
      ]) {
        expect(seen, `提示词里应含 ${fragment}`).toContain(fragment)
      }
    })

    it('没有知识时明确告诉模型这是第一次', async () => {
      let seen = ''
      const host = hostWith(async (req) => {
        seen = req.messages.map((m) => m.content).join('\n')
        return {
          text: '',
          structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
          model: 'm',
        }
      })

      await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(seen).toContain('第一次做这件事')
    })

    it('强制模型走工具调用', async () => {
      let schemaName: string | undefined
      const host = hostWith(async (req) => {
        schemaName = req.schema?.name
        return {
          text: '',
          structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
          model: 'm',
        }
      })

      await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(schemaName).toBe('propose_runbook')
    })

    it('不在调用点写死 maxTokens——预算由 provider 配置决定', async () => {
      let maxTokens: number | undefined
      const host = hostWith(async (req) => {
        maxTokens = req.maxTokens
        return {
          text: '',
          structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
          model: 'm',
        }
      })

      await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      // 推理型模型光思考就可能花掉三万字符，起草不该被调用点限死
      expect(maxTokens).toBeUndefined()
    })
  })
})
