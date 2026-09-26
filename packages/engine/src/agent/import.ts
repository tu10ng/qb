/**
 * 导入（模式 B）：把用户贴进来的素材忠实整理成带参数的 runbook。
 *
 * 命令逐字来自原文（宪法 12）；QB 只做结构化与参数提取。保真/覆盖
 * 校验在 engine 侧确定性地跑（fidelity.ts），不指望模型自觉。
 */

import { z } from 'zod'
import type { Environment } from '@qb/core'
import { KINDS, toTree, type FlatStep, type StepOut } from './draft.ts'
import type { Llm } from '../llm/port.ts'

const ParamOut = z.object({
  name: z.string().describe('大写下划线，如 PREFILL_IP').catch(''),
  value: z.string().describe('原文里的取值').catch(''),
  description: z.string().optional().describe('一句话说明').catch(undefined),
})

/** 归一参数名；归一后仍不合法（原名是中文之类）返回 null。 */
function normalizeName(raw: string): string | null {
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return /^[A-Z][A-Z0-9_]*$/.test(name) ? name : null
}

const ImportStep = z.object({
  section: z.string().describe('所属章节，如 1 检查 / 2 启动 / 3 验证').catch(''),
  kind: z.enum(KINDS).catch('manual'),
  title: z.string().min(1).describe('简短标题'),
  why: z.string().optional().describe('一句话：这步为何存在。原文的提醒写在这里').catch(undefined),
  command: z
    .string()
    .optional()
    .describe('参数写成 {{参数名}}；替换回去必须与原文逐字一致')
    .catch(undefined),
  expect: z.string().optional().describe('怎么知道这步成了（原文写的判定标准）').catch(undefined),
  minutes: z.number().positive().optional().describe('预计耗时，分钟').catch(undefined),
  source: z.string().optional().describe('原文中对应的那一小段，照抄').catch(undefined),
})

const LessonOut = z.object({
  symptom: z.string().describe('症状（原文怎么描述这个坑）').catch(''),
  fix: z.string().describe('修法/规避（照抄原文）').catch(''),
  stepIndex: z.number().int().optional().describe('关联步骤的序号，从 0 开始').catch(undefined),
})

export const ImportSchema = z.object({
  params: z.array(ParamOut.nullable().catch(null)).describe('从原文提取的参数').catch([]),
  steps: z
    .array(ImportStep.nullable().catch(null))
    .describe('有序步骤列表，用 section 标注章节，同章节要连续'),
  lessons: z.array(LessonOut.nullable().catch(null)).describe('原文里独立成条的坑').catch([]),
  gaps: z.array(z.string().catch('')).describe('原文没说清、需要人确认的地方').catch([]),
})

export interface ImportResult {
  params: Array<{ name: string; value: string; description?: string }>
  steps: StepOut[]
  lessons: Array<{ symptom: string; fix: string; stepIndex?: number }>
  gaps: string[]
  model: string
  dropped: number
}

export async function importMaterial(
  llm: Llm,
  persona: string,
  importPrompt: string,
  input: { material: string; environments: Environment[] },
  opts: { signal?: AbortSignal; onPartial?: (partial: unknown) => void } = {},
): Promise<ImportResult> {
  const prompt = importPrompt
    .replace('{{material}}', input.material)
    .replace('{{environment}}', renderEnvironments(input.environments))

  const result = await llm.structured({
    purpose: 'structure',
    name: 'imported_runbook',
    system: persona,
    prompt,
    schema: ImportSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onPartial !== undefined ? { onPartial: opts.onPartial } : {}),
  })

  const rawSteps = result.output.steps.filter((s): s is NonNullable<typeof s> => s !== null)
  if (rawSteps.length === 0) throw new Error('模型没有从素材里整理出任何步骤')

  const params = result.output.params
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ ...p, name: normalizeName(p.name) }))
    .filter((p): p is typeof p & { name: string } => p.name !== null)

  return {
    params: params.map((p) => ({
      name: p.name,
      value: p.value,
      ...(p.description !== undefined ? { description: p.description } : {}),
    })),
    steps: toTree(rawSteps as FlatStep[]),
    lessons: result.output.lessons.filter((l): l is NonNullable<typeof l> => l !== null && l.symptom !== ''),
    gaps: result.output.gaps.filter((g) => g.trim() !== ''),
    model: result.model,
    dropped: result.output.steps.length - rawSteps.length,
  }
}

function renderEnvironments(envs: Environment[]): string {
  if (envs.length === 0) return '（没有采集到环境信息）'
  return envs
    .map((e) => {
      const f = e.facts
      const bits = [f.os, f.shell, f.gpu, f.cuda !== undefined ? `CUDA ${f.cuda}` : undefined]
        .filter((x): x is string => x !== undefined)
        .join('，')
      return `- **${e.name}**：${bits}`
    })
    .join('\n')
}
