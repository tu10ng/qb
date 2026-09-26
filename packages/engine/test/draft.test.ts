import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DraftSchema, draftRunbook, partialSteps, type DraftContext } from '../src/agent/draft.ts'
import { LlmError } from '../src/llm/port.ts'
import { FakeLlm } from './fake-llm.ts'

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
    const llm = new FakeLlm({
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

    const result = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)

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
    expect(result.model).toBe('fake-model')
  })

  describe('section 还原成树', () => {
    it('多个 section 各自成章节，顺序保持', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [
          { section: '1 准备', kind: 'command', title: 'a' },
          { section: '1 准备', kind: 'command', title: 'b' },
          { section: '2 启动', kind: 'command', title: 'c' },
          { section: '3 验证', kind: 'check', title: 'd' },
        ],
      })

      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['1 准备', '2 启动', '3 验证'])
      expect(r.steps[0]!.children!.map((c) => c.title)).toEqual(['a', 'b'])
      expect(r.steps[1]!.children!.map((c) => c.title)).toEqual(['c'])
      expect(r.steps[2]!.children!.map((c) => c.title)).toEqual(['d'])
    })

    it('没有 section 的步骤放顶层', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: '单步任务', command: 'ls' }] })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps).toHaveLength(1)
      expect(r.steps[0]!.title).toBe('单步任务')
      expect(r.steps[0]!.children).toBeUndefined()
    })

    it('同名 section 不连续时各自成节——尊重模型给的顺序', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [
          { section: 'A', kind: 'command', title: 'a1' },
          { section: 'B', kind: 'command', title: 'b1' },
          { section: 'A', kind: 'command', title: 'a2' },
        ],
      })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['A', 'B', 'A'])
    })
  })

  describe('预期与探针的组装', () => {
    it('命令类步骤：expect 当成输出要包含的字样', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x', expect: 'Started server' }] })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({ kind: 'contains', text: 'Started server', caseSensitive: true })
    })

    it('人工类步骤：expect 当成人工判断标准', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [
          { kind: 'manual', title: '压测', expect: 'QPS 不低于单体部署' },
          { kind: 'decision', title: '选配比', expect: '和 PL 确认过' },
        ],
      })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toEqual({ kind: 'manual', description: 'QPS 不低于单体部署' })
      expect(r.steps[1]!.expectation).toEqual({ kind: 'manual', description: '和 PL 确认过' })
    })

    describe('wait 步骤的 expect 识别成就绪探针', () => {
      it('URL', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'wait', title: '等就绪', expect: 'http://gpu-17:8100/health' }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({ kind: 'http', url: 'http://gpu-17:8100/health', expectStatus: 200 })
        expect(r.steps[0]!.expectation).toBeUndefined()
      })

      it('host:port', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'wait', title: '等端口', expect: 'gpu-17:8200' }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({ kind: 'port', host: 'gpu-17', port: 8200 })
      })

      it('只给端口号时默认本机', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'wait', title: '等端口', expect: '8200' }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toEqual({ kind: 'port', host: '127.0.0.1', port: 8200 })
      })

      it('不像地址的文本退化成输出匹配', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'wait', title: '等加载', expect: 'Loading weights complete' }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.probe).toBeUndefined()
        expect(r.steps[0]!.expectation).toEqual({ kind: 'contains', text: 'Loading weights complete', caseSensitive: true })
      })
    })

    describe('超时由耗时推导', () => {
      it('取 3 倍', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x', minutes: 8 }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(8 * 60_000 * 3)
      })

      it('短任务有 30 秒下限——命令启动本身要时间', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x', minutes: 0.05 }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(30_000)
      })

      it('没给耗时时用兜底值', async () => {
        const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x' }] })
        const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
        expect(r.steps[0]!.timeoutMs).toBe(120_000)
      })
    })
  })

  describe('宽容校验（实测兼容端点上模型的输出习惯）', () => {
    it('模型调用失败时原样上抛，不包装成别的错误', async () => {
      const llm = new FakeLlm(() => {
        throw new LlmError('thinking_conflict', '开着思考时不支持强制结构化输出')
      })
      await expect(draftRunbook(llm, PERSONA, TEMPLATE, ctx)).rejects.toThrow(/思考/)
    })

    it('步骤为空时报错', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [] })
      await expect(draftRunbook(llm, PERSONA, TEMPLATE, ctx)).rejects.toThrow(/不合格式/)
    })

    it('空文本的预期被丢弃——它永远为真，等于没有预期', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x', expect: '   ' }] })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectation).toBeUndefined()
      expect(r.steps[0]!.title).toBe('x')
    })

    it('枚举外的 kind 按 manual 保留，而不是丢掉整步', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [
          { kind: 'command', title: '好的', command: 'ls' },
          { kind: 'note', title: '模型编出来的类型' },
        ],
      })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => [s.title, s.kind])).toEqual([
        ['好的', 'command'],
        ['模型编出来的类型', 'manual'],
      ])
    })

    it('缺标题的步骤丢掉，保留其余', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [{ kind: 'command', title: '好的' }, { kind: 'command' }, 'garbage', { kind: 'command', title: '也好的' }],
      })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps.map((s) => s.title)).toEqual(['好的', '也好的'])
    })

    it('可选字段类型不对时当作没填', async () => {
      const llm = new FakeLlm({
        assumptions: [],
        steps: [{ kind: 'command', title: 'x', minutes: '五分钟', command: 42, why: null }],
      })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.steps[0]!.expectedMinutes).toBeUndefined()
      expect(r.steps[0]!.command).toBeUndefined()
      expect(r.steps[0]!.timeoutMs).toBe(120_000)
    })

    it('缺 assumptions 时默认空数组', async () => {
      const llm = new FakeLlm({ steps: [{ kind: 'command', title: 'x' }] })
      const r = await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(r.assumptions).toEqual([])
    })

    it('缺顶层 steps 是结构性错误：校验失败（真实实现会重试一次）', async () => {
      const llm = new FakeLlm({ assumptions: [{ key: 'a', value: 'b' }] })
      await expect(draftRunbook(llm, PERSONA, TEMPLATE, ctx)).rejects.toThrow()
    })

    it('给模型看的契约仍然严格：kind 有枚举、title 必填', () => {
      const js = z.toJSONSchema(DraftSchema, { io: 'input' }) as {
        properties: { steps: { items: { anyOf: Array<{ properties?: Record<string, { enum?: string[] }>; required?: string[] }> } } }
      }
      const item = js.properties.steps.items.anyOf.find((s) => s.properties !== undefined)!
      expect(item.properties!.kind!.enum).toEqual(['command', 'check', 'wait', 'manual', 'decision'])
      expect(item.required).toContain('title')
    })
  })

  describe('流式部分结果', () => {
    it('只取已经有标题的步骤给界面预览', () => {
      expect(
        partialSteps({ steps: [{ section: '1', kind: 'command', title: 'a', command: 'ls' }, { section: '1', kind: 'com' }] }),
      ).toEqual([{ section: '1', kind: 'command', title: 'a', command: 'ls' }])
      expect(partialSteps(undefined)).toEqual([])
      expect(partialSteps({ steps: 'not-an-array' })).toEqual([])
    })

    it('部分结果经 onPartial 转给调用方', async () => {
      const seen: unknown[] = []
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x' }] })
      await draftRunbook(llm, PERSONA, TEMPLATE, ctx, { onPartial: (p) => seen.push(p) })
      expect(seen).toHaveLength(1)
    })
  })

  describe('提示词渲染', () => {
    it('把任务、环境、知识都填进模板', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x' }] })

      await draftRunbook(llm, PERSONA, TEMPLATE, {
        task: { title: '部署 vLLM', briefMd: 'PD 分离部署', expectedMinutes: null, definitionOfDone: null },
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
          { symptom: 'NCCL 卡在初始化', fixMd: '设 NCCL_IB_DISABLE=1', condition: '版本不一致时', nextTimeMd: '启动前先比对版本' },
        ],
      })

      const seen = `${llm.calls[0]!.system}\n${llm.calls[0]!.prompt}`
      for (const fragment of ['部署 vLLM', 'PD 分离部署', 'gpu-17', '8×H800', '走代理', 'pd-deploy', 'NCCL 卡在初始化', 'NCCL_IB_DISABLE=1', '启动前先比对版本']) {
        expect(seen, `提示词里应含 ${fragment}`).toContain(fragment)
      }
    })

    it('没有知识时明确告诉模型这是第一次', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x' }] })
      await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(llm.calls[0]!.prompt).toContain('第一次做这件事')
    })

    it('走"整理"用途的结构化调用', async () => {
      const llm = new FakeLlm({ assumptions: [], steps: [{ kind: 'command', title: 'x' }] })
      await draftRunbook(llm, PERSONA, TEMPLATE, ctx)
      expect(llm.calls[0]!.purpose).toBe('structure')
      expect(llm.calls[0]!.system).toBe(PERSONA)
    })
  })
})
