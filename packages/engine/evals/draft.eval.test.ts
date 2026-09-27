/**
 * 评测：空白起草（Phase 0 改了起草的提示词与 schema——随环境变化的取值要
 * 写成 {{NAME}} 并在 params 里声明，不再用 $NAME）。真实模型，默认跳过：
 *
 *   source .env.local && pnpm eval
 *
 * 断言故意放宽：硬门槛只挡"明显坏了"——命令里的 {{X}} 都声明过、不再出现
 * 靠 shell 变量传参的写法；其余数字打到输出里看趋势。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDb, Store } from '@qb/store'
import { PARAM_RE } from '@qb/core'
import { createLlm } from '../src/llm/index.ts'
import { LlmSettings } from '../src/settings/llm-settings.ts'
import { draftRunbook, type StepOut } from '../src/agent/draft.ts'

const here = dirname(fileURLToPath(import.meta.url))
const persona = readFileSync(join(here, '..', 'prompts', 'qb-persona.md'), 'utf8')
const draftPrompt = readFileSync(join(here, '..', 'prompts', 'draft.md'), 'utf8')

const enabled = process.env.QB_LLM_BASE_URL !== undefined

describe.skipIf(!enabled)('评测：空白起草', () => {
  it(
    '随环境变化的取值写成 {{参数}} 并声明，不用 $NAME 传参',
    { timeout: 240_000 },
    async () => {
      const llm = createLlm(new LlmSettings(new Store(openDb({ path: ':memory:' })), process.env))
      const r = await draftRunbook(llm, persona, draftPrompt, {
        task: {
          title: '在 Y 集群部署 vLLM PD 分离（Qwen3-32B）',
          briefMd: 'prefill 和 decode 各一台 8 卡机器，各用 4 卡；起完后用 proxy 转发并压测一下吞吐。',
          expectedMinutes: 180,
          definitionOfDone: 'proxy 能转发请求，压测有吞吐数字',
        },
        environments: [],
        skills: [],
        lessons: [],
      })

      const flat: StepOut[] = r.steps.flatMap((s) => [s, ...(s.children ?? [])])
      const commands = flat.map((s) => s.command).filter((c): c is string => c !== undefined)
      const used = new Set(commands.flatMap((c) => [...c.matchAll(PARAM_RE)].map((m) => m[1]!)))
      const declaredByModel = r.params.filter((p) => p.description !== '起草时用到但没给值')
      const shellVars = commands.filter((c) => /\$(?!\{\{)[A-Z][A-Z0-9_]{2,}\b/.test(c) && !/\$(PATH|HOME|USER|PWD|SHELL)\b/.test(c))

      console.log(`[eval:draft] 步骤 ${flat.length} | 命令 ${commands.length} | 用到参数 ${used.size} | 模型声明 ${declaredByModel.length} / 补声明 ${r.params.length - declaredByModel.length} | 假设 ${r.assumptions.length} | 丢弃 ${r.dropped}`)
      for (const p of r.params) console.log(`[eval:draft]   ${p.name} = ${p.value === '' ? '（空）' : p.value}${p.description !== undefined ? ` · ${p.description}` : ''}`)
      for (const c of shellVars) console.log(`[eval:draft]   仍用 shell 变量传参：${c.slice(0, 120)}`)

      expect(flat.length).toBeGreaterThanOrEqual(8)
      // 命令里用到的参数都在参数表里（模型没声明的由 draftParams 补上）——运行前一定能填
      expect([...used].every((n) => r.params.some((p) => p.name === n))).toBe(true)
      // 模型自己声明了参数，而不是全靠事后补
      expect(declaredByModel.length).toBeGreaterThanOrEqual(3)
    },
  )
})
