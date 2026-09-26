/**
 * 调整（模式 A 的差异）：拿这次的说明（PL 的话 / "情况变了"）对着
 * 当前 runbook 出一份差异。只提议，不直接应用——人逐项接受。
 */

import { z } from 'zod'
import type { Lesson, Param, Step } from '@qb/core'
import { renderCommand } from '@qb/core'
import { fillTemplate } from './prompt.ts'
import type { Llm } from '../llm/port.ts'

const ChangeOut = z.object({
  name: z.string().describe('参数名').catch(''),
  to: z.string().describe('这次的取值').catch(''),
  reason: z.string().optional().describe('依据（说明里的哪句话）').catch(undefined),
})

const NewParamOut = z.object({
  name: z.string().describe('大写下划线').catch(''),
  value: z.string().describe('取值（说明里没讲清就留空）').catch(''),
  description: z.string().optional().catch(undefined),
})

const StepEditOut = z.object({
  stepIndex: z.number().int().describe('步骤列表里的序号，从 0 开始').catch(-1),
  command: z.string().describe('新的命令模板，仍用 {{参数名}}').catch(''),
  reason: z.string().optional().catch(undefined),
})

const ObsoleteOut = z.object({
  what: z.string().describe('不再适用的坑或提醒').catch(''),
  reason: z.string().optional().catch(undefined),
})

export const AdaptSchema = z.object({
  paramChanges: z.array(ChangeOut.nullable().catch(null)).catch([]),
  newParams: z.array(NewParamOut.nullable().catch(null)).catch([]),
  stepEdits: z.array(StepEditOut.nullable().catch(null)).catch([]),
  obsolete: z.array(ObsoleteOut.nullable().catch(null)).catch([]),
  questions: z.array(z.string().catch('')).catch([]),
})

export interface AdaptProposal {
  paramChanges: Array<{ name: string; to: string; reason?: string }>
  newParams: Array<{ name: string; value: string; description?: string }>
  stepEdits: Array<{ stepIndex: number; command: string; reason?: string }>
  obsolete: Array<{ what: string; reason?: string }>
  questions: string[]
  /** 模型引用的步骤序号越界或对不上名字时，把那步的修改丢掉并记在这里。 */
  rejectedStepEdits: Array<{ stepIndex: number; reason: string }>
  model: string
}

export interface AdaptInput {
  message: string
  params: Param[]
  steps: Step[]
  lessons: Array<Pick<Lesson, 'symptom' | 'fixMd' | 'condition'>>
}

export async function proposeAdapt(
  llm: Llm,
  persona: string,
  adaptPrompt: string,
  input: AdaptInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AdaptProposal> {
  // 模型看到的步骤列表：只列有内容的行（跳过章节标题），带渲染后的命令
  const indexed = input.steps
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.kind !== 'note' || s.parentId !== null)

  // 单趟填充：说明里写着 {{steps}} 之类的占位不会被吃掉
  const prompt = fillTemplate(adaptPrompt, {
    params:
      input.params.length === 0
        ? '（还没有参数）'
        : input.params.map((p) => `- ${p.name} = ${p.value === '' ? '（空）' : p.value}${p.description !== undefined ? `（${p.description}）` : ''}`).join('\n'),
    steps:
      indexed.length === 0
        ? '（还没有步骤）'
        : indexed
            .map(({ s, index }) => {
              const rendered = s.command !== null ? renderCommand(s.command, input.params).text : null
              return `${index}. ${s.title}${rendered !== null ? `\n   $ ${rendered}` : ''}${s.whyMd !== null ? `\n   为什么：${s.whyMd}` : ''}`
            })
            .join('\n'),
    lessons:
      input.lessons.length === 0
        ? '（没有）'
        : input.lessons.map((l) => `- ${l.condition !== null ? `【${l.condition}】` : ''}${l.symptom} → ${l.fixMd}`).join('\n'),
    message: input.message,
  })

  const result = await llm.structured({
    purpose: 'structure',
    name: 'adaptation',
    system: persona,
    prompt,
    schema: AdaptSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })

  const validIdx = new Set(indexed.map(({ index }) => index))
  const stepEdits: AdaptProposal['stepEdits'] = []
  const rejected: AdaptProposal['rejectedStepEdits'] = []
  for (const e of result.output.stepEdits) {
    if (e === null) continue
    if (!validIdx.has(e.stepIndex) || e.command.trim() === '') {
      rejected.push({ stepIndex: e.stepIndex, reason: '步骤序号对不上' })
      continue
    }
    stepEdits.push({ stepIndex: e.stepIndex, command: e.command, ...(e.reason !== undefined ? { reason: e.reason } : {}) })
  }

  // 改动引用了当前没有的参数名也没关系：应用时找不到就新建同名参数。
  // 名字归一成大写下划线（与 newParams 一致），归一后仍非法的丢掉。
  const paramChanges = result.output.paramChanges
    .filter((c): c is NonNullable<typeof c> => c !== null && c.name !== '')
    .map((c) => ({ ...c, name: c.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))
    .filter((c) => /^[A-Z][A-Z0-9_]*$/.test(c.name))
    .map((c) => ({ name: c.name, to: c.to, ...(c.reason !== undefined ? { reason: c.reason } : {}) }))

  return {
    paramChanges,
    newParams: result.output.newParams
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({ ...p, name: p.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))
      .filter((p) => /^[A-Z][A-Z0-9_]*$/.test(p.name)),
    stepEdits,
    obsolete: result.output.obsolete.filter((o): o is NonNullable<typeof o> => o !== null && o.what !== ''),
    questions: result.output.questions.filter((q) => q.trim() !== ''),
    rejectedStepEdits: rejected,
    model: result.model,
  }
}
