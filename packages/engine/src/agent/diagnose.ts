/**
 * QB 的陪跑能力：一步失败时给出诊断和可选路径。
 *
 * 流程：先按症状检索坑（本地 FTS，零成本）→ 把命中的坑和执行现场
 * 一起交给模型 → 模型给出诊断与 2-3 条可执行路径。
 *
 * 检索在前是刻意的：团队踩过的坑比模型的推测可信得多，而且检索不花
 * token、不花时间。模型的作用是判断哪条坑真的匹配、以及没有坑时怎么办。
 */

import { z } from 'zod'
import type { Lesson, Step } from '@qb/core'
import type { ImageInput, Llm } from '../llm/port.ts'

/** 诊断输出。给模型的契约严格，校验宽容：一条路径坏了只丢这一条。 */
export const DiagnoseSchema = z.object({
  summary: z.string().min(1).describe('一句话说清问题，不超过 40 字'),
  fromLesson: z.string().optional().describe('命中的坑 id。没有命中就省略。').catch(undefined),
  options: z
    .array(
      z
        .object({
          label: z.string().min(1).describe('按钮上的字，不超过 12 字'),
          detail: z.string().describe('做什么、为什么、代价').catch(''),
          command: z.string().optional().describe('要改成或补跑的命令。没有就省略。').catch(undefined),
        })
        .nullable()
        .catch(null),
    )
    .describe('可选路径，按可能性排序，2-3 条')
    .catch([]),
  askInstead: z
    .string()
    .optional()
    .describe('如果最该做的是问人，填建议问谁、问什么。否则省略。')
    .catch(undefined),
})

export interface DiagnoseInput {
  step: Pick<Step, 'title' | 'command' | 'whyMd' | 'expectation'>
  /** 执行现场。 */
  outcome: {
    exitCode: number | null
    timedOut: boolean
    durationMs: number
    output: string
    verdict: string
    reason: string
  }
  /** 已检索到的候选坑。 */
  lessons: Lesson[]
  /** 环境事实，用于判断坑的条件是否匹配。 */
  environmentNote: string
  /** 用户贴回来的最近一张截图（有的话）。 */
  image?: ImageInput
}

export interface Diagnosis {
  summary: string
  fromLessonId: string | null
  options: Array<{ label: string; detail: string; command?: string }>
  askInstead: string | null
  model: string
}

/** 交给模型的输出片段上限。太长会挤掉坑的上下文，且尾部才是关键。 */
const OUTPUT_TAIL_CHARS = 3000

export async function diagnoseFailure(
  llm: Llm,
  persona: string,
  diagnosePrompt: string,
  input: DiagnoseInput,
  signal?: AbortSignal,
): Promise<Diagnosis> {
  // 有截图时交给能看图的档案；没有就用诊断档案
  const result = await llm.structured({
    purpose: input.image !== undefined ? 'vision' : 'diagnose',
    name: 'diagnosis',
    system: `${persona}\n\n---\n\n${diagnosePrompt}`,
    prompt: renderSituation(input),
    schema: DiagnoseSchema,
    ...(input.image !== undefined ? { images: [input.image] } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })

  const parsed = result.output

  // 模型可能引用一个不存在的坑 id（幻觉）。校验后再采信，
  // 否则 UI 上会出现点不开的"出处"链接。
  const validLessonId =
    parsed.fromLesson !== undefined && input.lessons.some((l) => l.id === parsed.fromLesson)
      ? parsed.fromLesson
      : null

  return {
    summary: parsed.summary,
    fromLessonId: validLessonId,
    options: parsed.options
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => ({ label: o.label, detail: o.detail, ...(o.command !== undefined ? { command: o.command } : {}) })),
    askInstead: parsed.askInstead ?? null,
    model: result.model,
  }
}

function renderSituation(input: DiagnoseInput): string {
  const { step, outcome, lessons, environmentNote } = input

  const parts: string[] = [
    '# 出问题的这一步',
    '',
    `**${step.title}**`,
  ]

  if (step.whyMd !== null && step.whyMd !== undefined) {
    parts.push(`这步的目的：${step.whyMd}`)
  }
  if (step.command !== null && step.command !== undefined) {
    parts.push('', '执行的命令：', '```', step.command, '```')
  }
  if (step.expectation !== null && step.expectation !== undefined) {
    parts.push(`预期：${JSON.stringify(step.expectation)}`)
  }

  parts.push(
    '',
    '# 实际结果',
    '',
    outcome.timedOut
      ? `**超时**（跑了 ${Math.round(outcome.durationMs / 1000)} 秒仍未结束）`
      : `退出码 ${outcome.exitCode ?? '无（被信号终止）'}，耗时 ${Math.round(outcome.durationMs / 1000)} 秒`,
    `判定：${outcome.verdict} — ${outcome.reason}`,
  )

  const output = outcome.output.trim()
  if (output !== '') {
    // 只给尾部：报错通常在最后，前面的进度输出没有诊断价值
    const tail =
      output.length > OUTPUT_TAIL_CHARS
        ? `……（前 ${output.length - OUTPUT_TAIL_CHARS} 字符省略）\n${output.slice(-OUTPUT_TAIL_CHARS)}`
        : output
    parts.push('', '输出：', '```', tail, '```')
  }

  if (input.image !== undefined) {
    parts.push('', '（附图是用户贴回来的截图，报错可能只在图里。）')
  }

  parts.push('', '# 执行环境', '', environmentNote)

  parts.push('', '# 团队踩过的相关坑', '')
  if (lessons.length === 0) {
    parts.push('（没有检索到相关的坑。这可能是团队第一次遇到。）')
  } else {
    for (const l of lessons) {
      const cond = l.condition !== null ? `条件：${l.condition}\n  ` : ''
      const next = l.nextTimeMd !== null ? `\n  下次应当：${l.nextTimeMd}` : ''
      const trust =
        l.scope === 'team'
          ? '团队已确认'
          : l.confirmedAt !== null
            ? '已确认'
            : '个人记录，未经他人验证'
      const stats =
        l.hitCount > 0 ? `，用过 ${l.hitCount} 次有效` : l.missCount > 0 ? `，用过但没解决问题` : ''

      parts.push(
        `- [id: ${l.id}] ${cond}症状：${l.symptom}`,
        `  修法：${l.fixMd}${next}`,
        `  来源：${trust}${stats}`,
      )
    }
  }

  return parts.join('\n')
}
