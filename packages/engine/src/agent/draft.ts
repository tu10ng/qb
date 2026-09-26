/**
 * QB 的起草能力：把一句模糊的目标展开成可执行的 runbook。
 *
 * 结构化输出走工具调用（见 provider.ts），schema 与 @qb/core 的领域
 * 模型对齐。模型返回后仍要过一遍 zod 校验——工具调用不保证语义正确，
 * 只保证形状大致正确。
 */

import { z } from 'zod'
import type { Environment, Lesson, Skill, Task } from '@qb/core'
import type { HostPort } from '../dsh/port.ts'

// ── 模型输出的 schema ────────────────────────────────────────

/**
 * 模型输出的 schema。
 *
 * 设计取舍（都有实测依据）：
 *
 * 1. **结构扁平**。递归的 children 会让推理型模型的思考量明显上升；
 *    章节改用 section 字段表达，写库时还原成树。
 * 2. **字段尽量少**。每个可选字段模型都要权衡"这步要不要填"。
 *    expect 是一个自由文本字段，由代码推断它是"输出包含某字样"、
 *    "人工判断"还是"就绪 URL"——这个判断机械且确定，不该占模型的预算。
 * 3. **超时不让模型算**。由 minutes 推导，它算出来的经常不合理。
 *
 * 即便如此，GLM-5.3 这类推理模型在这个任务上的思考量仍会在
 * 7k~52k 字符之间大幅波动（实测），耗时从 40 秒到 4 分钟。
 * 所以起草在 API 层做成异步任务，不让用户干等。
 */
export const DRAFT_SCHEMA = {
  name: 'propose_runbook',
  description: '提交起草好的 runbook',
  parameters: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        description: '信息不全时你做出的假设。用户会在文档顶部看到并可修改。',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '假设的维度，如集群、模型版本' },
            value: { type: 'string', description: '你假设的取值' },
          },
          required: ['key', 'value'],
        },
      },
      steps: {
        type: 'array',
        description: '有序的步骤列表，8-20 步。用 section 标注所属章节，同章节的步骤要连续。',
        items: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: '所属章节，如 1 准备 / 2 启动 / 3 验证 / 4 交接',
            },
            kind: {
              type: 'string',
              enum: ['command', 'check', 'wait', 'manual', 'decision'],
              description:
                'command=可直接跑的命令；check=验证状态；wait=长任务需等就绪；manual=只有人能做；decision=需要拍板',
            },
            title: { type: 'string', description: '简短标题' },
            why: { type: 'string', description: '一句话：这步为何存在、为何是这个顺序' },
            command: { type: 'string', description: '精确到可直接复制运行的命令' },
            expect: {
              type: 'string',
              description:
                '怎么知道这步成了。输出里会出现的关键字样（如 Started server），或人工判断标准。wait 步骤填要探测的 URL。',
            },
            minutes: { type: 'number', description: '预计耗时，分钟，可以是小数' },
          },
          required: ['section', 'kind', 'title'],
        },
      },
    },
    required: ['assumptions', 'steps'],
  },
} as const

// ── 校验 ─────────────────────────────────────────────────────

/** 模型返回的扁平步骤。 */
const FlatStep = z.object({
  section: z.string().default(''),
  kind: z.enum(['command', 'check', 'wait', 'manual', 'decision']),
  title: z.string().min(1),
  why: z.string().optional(),
  command: z.string().optional(),
  expect: z.string().optional(),
  minutes: z.number().positive().optional(),
})

const DraftOutput = z.object({
  assumptions: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  // 单个步骤不合格就丢掉它，不因此废掉整份 runbook
  steps: z
    .array(FlatStep.catch(() => null as never))
    .transform((arr) => arr.filter((s) => s !== null)),
})

type Flat = z.infer<typeof FlatStep>

interface StepOut {
  kind: 'command' | 'check' | 'wait' | 'manual' | 'decision' | 'note'
  title: string
  whyMd?: string
  whySource?: string
  command?: string
  expectation?: unknown
  probe?: unknown
  timeoutMs?: number
  expectedMinutes?: number
  children?: StepOut[]
}

/** 按 section 把扁平列表还原成两层树。 */
function toTree(flat: Flat[]): StepOut[] {
  const out: StepOut[] = []
  let currentSection: string | null = null
  let currentNode: StepOut | null = null

  for (const f of flat) {
    const step = toStepOut(f)
    const section = f.section.trim()

    // 没有章节名的步骤直接放顶层
    if (section === '') {
      out.push(step)
      currentSection = null
      currentNode = null
      continue
    }

    if (section !== currentSection) {
      currentSection = section
      currentNode = { kind: 'note', title: section, children: [] }
      out.push(currentNode)
    }

    currentNode!.children!.push(step)
  }

  return out
}

/** 超时相对预期耗时的倍数。给足余量，但不至于让人等到怀疑。 */
const TIMEOUT_FACTOR = 3
/** 没有耗时估计时的兜底超时。 */
const FALLBACK_TIMEOUT_MS = 120_000

function toStepOut(f: Flat): StepOut {
  const step: StepOut = { kind: f.kind, title: f.title }

  if (f.why !== undefined && f.why.trim() !== '') step.whyMd = f.why
  if (f.command !== undefined && f.command.trim() !== '') step.command = f.command
  if (f.minutes !== undefined) step.expectedMinutes = f.minutes

  // 超时由耗时估计推导，不让模型再算一遍——它算出来的经常不合理，
  // 而这个换算是纯机械的。
  step.timeoutMs =
    f.minutes !== undefined
      ? Math.max(30_000, Math.round(f.minutes * 60_000 * TIMEOUT_FACTOR))
      : FALLBACK_TIMEOUT_MS

  const expect = f.expect?.trim() ?? ''
  if (expect !== '') {
    const probe = asProbe(expect)
    if (probe !== null && f.kind === 'wait') {
      step.probe = probe
    } else if (isHumanJudgement(f.kind)) {
      step.expectation = { kind: 'manual', description: expect }
    } else {
      // 命令类步骤：expect 是输出里会出现的字样
      step.expectation = { kind: 'contains', text: expect, caseSensitive: true }
    }
  }

  return step
}

/** expect 看起来像个 URL 或 host:port 就当成就绪探针。 */
function asProbe(expect: string): unknown {
  const url = /^https?:\/\/\S+$/.exec(expect)
  if (url !== null) return { kind: 'http', url: expect, expectStatus: 200 }

  const hostPort = /^([\w.-]+):(\d{2,5})$/.exec(expect)
  if (hostPort !== null) {
    return { kind: 'port', host: hostPort[1]!, port: Number(hostPort[2]!) }
  }

  // 只给了端口号
  const bare = /^:?(\d{2,5})$/.exec(expect)
  if (bare !== null) return { kind: 'port', host: '127.0.0.1', port: Number(bare[1]!) }

  return null
}

function isHumanJudgement(kind: Flat['kind']): boolean {
  return kind === 'manual' || kind === 'decision'
}

// ── 起草 ─────────────────────────────────────────────────────

export interface DraftContext {
  task: Pick<Task, 'title' | 'briefMd' | 'expectedMinutes' | 'definitionOfDone'>
  environments: Environment[]
  skills: Array<Pick<Skill, 'name' | 'description' | 'appliesWhen'>>
  lessons: Array<Pick<Lesson, 'symptom' | 'fixMd' | 'condition' | 'nextTimeMd'>>
}

export interface DraftResult {
  assumptions: Array<{ key: string; value: string; editedByUser: boolean }>
  steps: StepOut[]
  model: string
}

export async function draftRunbook(
  host: HostPort,
  persona: string,
  template: string,
  ctx: DraftContext,
  signal?: AbortSignal,
  onProgress?: (p: { kind: 'thinking' | 'writing'; chars: number }) => void,
): Promise<DraftResult> {
  const prompt = renderTemplate(template, {
    title: ctx.task.title,
    brief: ctx.task.briefMd.trim() === '' ? '（没有更多说明）' : ctx.task.briefMd,
    expectations: renderExpectations(ctx.task),
    environment: renderEnvironments(ctx.environments),
    knowledge: renderKnowledge(ctx.skills, ctx.lessons),
  })

  const completion = await host.complete({
    messages: [
      { role: 'system', content: persona },
      { role: 'user', content: prompt },
    ],
    schema: DRAFT_SCHEMA,
    // 不在这里定上限：起草是最重的调用，推理型模型光思考就可能花掉
    // 三万字符。预算由 provider 配置决定（config.llm.maxTokens）。
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  })

  if (completion.structured === undefined) {
    throw new Error(`模型没有返回结构化结果。它说：${completion.text.slice(0, 300)}`)
  }

  const parsed = DraftOutput.parse(completion.structured)
  if (parsed.steps.length === 0) {
    throw new Error('模型返回的步骤全部不合格式')
  }

  return {
    assumptions: parsed.assumptions.map((a) => ({ ...a, editedByUser: false })),
    // 扁平列表按 section 还原成树
    steps: toTree(parsed.steps),
    model: completion.model,
  }
}

// ── 模板渲染 ─────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
}

function renderExpectations(task: DraftContext['task']): string {
  const parts: string[] = []
  if (task.expectedMinutes !== null && task.expectedMinutes !== undefined) {
    parts.push(`**预计耗时**：${task.expectedMinutes} 分钟`)
  }
  if (task.definitionOfDone !== null && task.definitionOfDone !== undefined) {
    parts.push(`**完成定义**：${task.definitionOfDone}`)
  }
  return parts.join('\n\n')
}

function renderEnvironments(envs: Environment[]): string {
  if (envs.length === 0) {
    return '（没有采集到环境信息。命令请用通用写法，并把环境相关的取值写进 assumptions。）'
  }

  return envs
    .map((e) => {
      const f = e.facts
      const facts = [
        f.os !== undefined ? `系统 ${f.os}` : null,
        f.shell !== undefined ? `shell ${f.shell}` : null,
        f.arch !== undefined ? `架构 ${f.arch}` : null,
        f.gpu !== undefined ? `GPU ${f.gpu}` : null,
        f.cuda !== undefined ? `CUDA ${f.cuda}` : null,
        f.proxy !== undefined ? `代理 ${f.proxy}` : null,
      ].filter((x): x is string => x !== null)

      const quirks =
        f.quirks !== undefined && f.quirks.length > 0
          ? `\n  注意：${f.quirks.join('；')}`
          : ''

      return `- **${e.name}**：${facts.join('，')}${quirks}`
    })
    .join('\n')
}

function renderKnowledge(
  skills: DraftContext['skills'],
  lessons: DraftContext['lessons'],
): string {
  const parts: string[] = []

  if (skills.length > 0) {
    parts.push(
      '## 相关 skill（团队做这类事的既有套路）\n' +
        skills
          .map(
            (s) =>
              `- **${s.name}**：${s.description}` +
              (s.appliesWhen !== null ? `（适用于：${s.appliesWhen}）` : ''),
          )
          .join('\n'),
    )
  }

  if (lessons.length > 0) {
    parts.push(
      '## 相关的坑（历史上踩过，务必在步骤里规避）\n' +
        lessons
          .map((l) => {
            const when = l.condition !== null ? `【${l.condition}】` : ''
            const next = l.nextTimeMd !== null ? `\n  下次应当：${l.nextTimeMd}` : ''
            return `- ${when}${l.symptom}\n  修法：${l.fixMd}${next}`
          })
          .join('\n'),
    )
  }

  return parts.length === 0
    ? '（团队还没有相关的 skill 和坑。这是第一次做这件事，凭领域常识起草，不确定的写进 assumptions。）'
    : parts.join('\n\n')
}
