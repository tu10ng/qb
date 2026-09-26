import { describe, expect, it } from 'vitest'
import { draftRunbook, type DraftContext } from '../src/agent/draft.ts'
import type { Completion, CompletionRequest, HostPort } from '../src/dsh/port.ts'
import { FakeHost } from './fake-host.ts'

/** 返回预设结构化输出的 host。 */
function hostReturning(structured: unknown, text = ''): HostPort {
  const base = new FakeHost()
  return {
    ...base,
    info: base.info,
    runCommand: base.runCommand.bind(base),
    startCommand: base.startCommand.bind(base),
    schedule: base.schedule.bind(base),
    complete: async (_req: CompletionRequest): Promise<Completion> => ({
      text,
      ...(structured !== undefined ? { structured } : {}),
      model: 'test-model',
    }),
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
          kind: 'note',
          title: '1 准备',
          children: [
            {
              kind: 'command',
              title: '检查 GPU',
              whyMd: '显存不够会白起',
              command: 'nvidia-smi',
              expectation: { kind: 'exitCode', code: 0 },
              timeoutMs: 15000,
              expectedMinutes: 0.2,
            },
          ],
        },
      ],
    })

    const result = await draftRunbook(host, PERSONA, TEMPLATE, ctx)

    expect(result.assumptions).toEqual([{ key: '集群', value: 'X', editedByUser: false }])
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.children).toHaveLength(1)
    expect(result.steps[0]!.children![0]!.command).toBe('nvidia-smi')
    expect(result.model).toBe('test-model')
  })

  it('模型没返回结构化结果时报错并带上它说了什么', async () => {
    const host = hostReturning(undefined, '我需要更多信息才能起草')
    await expect(draftRunbook(host, PERSONA, TEMPLATE, ctx)).rejects.toThrow(/我需要更多信息/)
  })

  it('步骤为空时报错', async () => {
    const host = hostReturning({ assumptions: [], steps: [] })
    await expect(draftRunbook(host, PERSONA, TEMPLATE, ctx)).rejects.toThrow()
  })

  describe('容错：模型输出不完整时补默认值而非整份丢弃', () => {
    it('exitCode 缺 code 时默认 0', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', expectation: { kind: 'exitCode' } }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({ kind: 'exitCode', code: 0 })
    })

    it('contains 缺 caseSensitive 时默认 true', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [
          { kind: 'command', title: 'x', expectation: { kind: 'contains', text: 'Started' } },
        ],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({
        kind: 'contains',
        text: 'Started',
        caseSensitive: true,
      })
    })

    it('空文本的 contains 被丢弃——它永远为真，等于没有预期', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', expectation: { kind: 'contains', text: '' } }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toBeUndefined()
      // 步骤本身保留
      expect(r.steps[0]!.title).toBe('x')
    })

    it('预期结构完全错乱时丢掉预期但保留步骤', async () => {
      const host = hostReturning({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', command: 'ls', expectation: 'not an object' }],
      })
      const r = await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.command).toBe('ls')
      expect(r.steps[0]!.expectation).toBeUndefined()
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
      const base = new FakeHost()
      const host: HostPort = {
        ...base,
        info: base.info,
        runCommand: base.runCommand.bind(base),
        startCommand: base.startCommand.bind(base),
        schedule: base.schedule.bind(base),
        complete: async (req) => {
          seen = req.messages.map((m) => m.content).join('\n')
          return {
            text: '',
            structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
            model: 'm',
          }
        },
      }

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
        skills: [
          { name: 'pd-deploy', description: 'PD 分离部署套路', appliesWhen: 'vLLM 0.11+' },
        ],
        lessons: [
          {
            symptom: 'NCCL 卡在初始化',
            fixMd: '设 NCCL_IB_DISABLE=1',
            condition: '版本不一致时',
            nextTimeMd: '启动前先比对版本',
          },
        ],
      })

      expect(seen).toContain('部署 vLLM')
      expect(seen).toContain('PD 分离部署')
      expect(seen).toContain('gpu-17')
      expect(seen).toContain('8×H800')
      expect(seen).toContain('走代理')
      expect(seen).toContain('pd-deploy')
      expect(seen).toContain('NCCL 卡在初始化')
      expect(seen).toContain('NCCL_IB_DISABLE=1')
      expect(seen).toContain('启动前先比对版本')
    })

    it('没有知识时明确告诉模型这是第一次', async () => {
      let seen = ''
      const base = new FakeHost()
      const host: HostPort = {
        ...base,
        info: base.info,
        runCommand: base.runCommand.bind(base),
        startCommand: base.startCommand.bind(base),
        schedule: base.schedule.bind(base),
        complete: async (req) => {
          seen = req.messages.map((m) => m.content).join('\n')
          return {
            text: '',
            structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
            model: 'm',
          }
        },
      }

      await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(seen).toContain('第一次做这件事')
    })

    it('强制模型走工具调用', async () => {
      let schemaName: string | undefined
      const base = new FakeHost()
      const host: HostPort = {
        ...base,
        info: base.info,
        runCommand: base.runCommand.bind(base),
        startCommand: base.startCommand.bind(base),
        schedule: base.schedule.bind(base),
        complete: async (req) => {
          schemaName = req.schema?.name
          return {
            text: '',
            structured: { assumptions: [], steps: [{ kind: 'command', title: 'x' }] },
            model: 'm',
          }
        },
      }

      await draftRunbook(host, PERSONA, TEMPLATE, ctx)
      expect(schemaName).toBe('propose_runbook')
    })
  })
})
