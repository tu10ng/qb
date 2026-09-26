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

/** 递归的步骤 schema。JSON Schema 里用 $ref 表达递归。 */
const STEP_PROPERTIES = {
  kind: {
    type: 'string',
    enum: ['command', 'check', 'wait', 'manual', 'decision', 'note'],
    description: '步骤类型。note 用作章节标题，把具体步骤放进 children。',
  },
  title: { type: 'string', description: '简短标题，一眼能看出这步在做什么' },
  whyMd: {
    type: 'string',
    description: '一句话说明这步为何存在、为何是这个顺序。新人最需要这个。',
  },
  whySource: {
    type: 'string',
    description: '依据来源，如 skill「PD分离」§3 或 lesson:xxx。没有就省略。',
  },
  command: { type: 'string', description: '精确到可直接复制运行的命令' },
  expectation: {
    type: 'object',
    description: '这步算不算做成了的判定标准',
    properties: {
      kind: { type: 'string', enum: ['exitCode', 'contains', 'notContains', 'regex', 'manual'] },
      code: { type: 'number' },
      text: { type: 'string' },
      caseSensitive: { type: 'boolean' },
      pattern: { type: 'string' },
      flags: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['kind'],
  },
  probe: {
    type: 'object',
    description: 'wait 步骤的就绪探针',
    properties: {
      kind: { type: 'string', enum: ['http', 'port', 'logPattern', 'command'] },
      url: { type: 'string' },
      expectStatus: { type: 'number' },
      host: { type: 'string' },
      port: { type: 'number' },
      pattern: { type: 'string' },
      command: { type: 'string' },
      expectExitCode: { type: 'number' },
    },
    required: ['kind'],
  },
  timeoutMs: { type: 'number', description: '止损线，设成预期耗时的 2-3 倍' },
  expectedMinutes: { type: 'number', description: '给人看的心理预期，可以是小数' },
} as const

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
            key: { type: 'string', description: '假设的维度，如"集群"、"模型版本"' },
            value: { type: 'string', description: '你假设的取值' },
          },
          required: ['key', 'value'],
        },
      },
      steps: {
        type: 'array',
        description: '顶层步骤。用 note 类型作章节，具体步骤放进 children。',
        items: {
          type: 'object',
          properties: {
            ...STEP_PROPERTIES,
            children: {
              type: 'array',
              description: '子步骤（章节内容）',
              items: { type: 'object', properties: STEP_PROPERTIES, required: ['kind', 'title'] },
            },
          },
          required: ['kind', 'title'],
        },
      },
    },
    required: ['assumptions', 'steps'],
  },
} as const

// ── 校验 ─────────────────────────────────────────────────────

const ExpectationOut = z
  .object({
    kind: z.enum(['exitCode', 'contains', 'notContains', 'regex', 'manual']),
    code: z.number().optional(),
    text: z.string().optional(),
    caseSensitive: z.boolean().optional(),
    pattern: z.string().optional(),
    flags: z.string().optional(),
    description: z.string().optional(),
  })
  .transform((e) => {
    // 模型可能漏掉分支必需的字段，补上合理默认而不是整份丢弃
    switch (e.kind) {
      case 'exitCode':
        return { kind: 'exitCode' as const, code: e.code ?? 0 }
      case 'contains':
        return {
          kind: 'contains' as const,
          text: e.text ?? '',
          caseSensitive: e.caseSensitive ?? true,
        }
      case 'notContains':
        return { kind: 'notContains' as const, text: e.text ?? '' }
      case 'regex':
        return { kind: 'regex' as const, pattern: e.pattern ?? '.*', flags: e.flags ?? '' }
      case 'manual':
        return { kind: 'manual' as const, description: e.description ?? '人工确认' }
    }
  })
  // 空文本的 contains 永远为真，等于没有预期——丢掉比留着误导好
  .refine(
    (e) => !((e.kind === 'contains' || e.kind === 'notContains') && e.text === ''),
    '文本预期不能为空',
  )

const ProbeOut = z
  .object({
    kind: z.enum(['http', 'port', 'logPattern', 'command']),
    url: z.string().optional(),
    expectStatus: z.number().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    pattern: z.string().optional(),
    command: z.string().optional(),
    expectExitCode: z.number().optional(),
  })
  .transform((p) => {
    switch (p.kind) {
      case 'http':
        return { kind: 'http' as const, url: p.url ?? '', expectStatus: p.expectStatus ?? 200 }
      case 'port':
        return { kind: 'port' as const, host: p.host ?? '127.0.0.1', port: p.port ?? 0 }
      case 'logPattern':
        return { kind: 'logPattern' as const, pattern: p.pattern ?? '' }
      case 'command':
        return {
          kind: 'command' as const,
          command: p.command ?? '',
          expectExitCode: p.expectExitCode ?? 0,
        }
    }
  })

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

const StepOutSchema: z.ZodType<StepOut> = z.lazy(() =>
  z.object({
    kind: z.enum(['command', 'check', 'wait', 'manual', 'decision', 'note']),
    title: z.string().min(1),
    whyMd: z.string().optional(),
    whySource: z.string().optional(),
    command: z.string().optional(),
    expectation: ExpectationOut.optional().catch(undefined),
    probe: ProbeOut.optional().catch(undefined),
    timeoutMs: z.number().positive().optional(),
    expectedMinutes: z.number().positive().optional(),
    children: z.array(StepOutSchema).optional(),
  }),
)

const DraftOutput = z.object({
  assumptions: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  steps: z.array(StepOutSchema).min(1),
})

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
    maxTokens: 8192,
    ...(signal !== undefined ? { signal } : {}),
  })

  if (completion.structured === undefined) {
    throw new Error(`模型没有返回结构化结果。它说：${completion.text.slice(0, 300)}`)
  }

  const parsed = DraftOutput.parse(completion.structured)

  return {
    assumptions: parsed.assumptions.map((a) => ({ ...a, editedByUser: false })),
    steps: parsed.steps,
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
