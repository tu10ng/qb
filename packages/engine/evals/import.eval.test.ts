/**
 * 评测集第一版（M7）：真实模型跑导入与差异，量保真率 / 参数召回 /
 * 差异正确性。默认跳过——要花钱花时间：
 *
 *   source .env.local && pnpm eval
 *
 * 断言故意放宽（模型有波动，评测的意义是每次改动后对比数字）：
 * 硬门槛只挡"明显坏了"的情况，其余打到输出里供人看趋势。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDb, Store } from '@qb/store'
import { checkFidelity } from '@qb/core'
import { createLlm } from '../src/llm/index.ts'
import { LlmSettings } from '../src/settings/llm-settings.ts'
import { importMaterial } from '../src/agent/import.ts'
import { proposeAdapt } from '../src/agent/adapt.ts'
import type { Param, Step } from '@qb/core'

const here = dirname(fileURLToPath(import.meta.url))
const wiki = readFileSync(join(here, 'fixtures', 'pd-wiki.md'), 'utf8')
const plMessage = readFileSync(join(here, 'fixtures', 'pl-message.md'), 'utf8')
const persona = readFileSync(join(here, '..', 'prompts', 'qb-persona.md'), 'utf8')
const importPrompt = readFileSync(join(here, '..', 'prompts', 'import.md'), 'utf8')
const adaptPrompt = readFileSync(join(here, '..', 'prompts', 'adapt.md'), 'utf8')

const enabled = process.env.QB_LLM_BASE_URL !== undefined

describe.skipIf(!enabled)('评测：导入（模式 B）', () => {
  it(
    '忠实结构化 + 参数提取 + 保真',
    { timeout: 180_000 },
    async () => {
      const llm = createLlm(new LlmSettings(new Store(openDb({ path: ':memory:' })), process.env))
      const r = await importMaterial(llm, persona, importPrompt, { material: wiki, environments: [] })

      const params: Param[] = r.params.map((p) => ({ ...p, source: 'origin', secret: false }))
      const flat: string[] = []
      for (const s of r.steps) {
        if (s.command !== undefined) flat.push(s.command)
        for (const c of s.children ?? []) if (c.command !== undefined) flat.push(c.command)
      }
      const fidelity = checkFidelity(flat, wiki, params)
      const verbatim = fidelity.items.filter((i) => i.verbatim).length

      // ── 数字看趋势，硬门槛只挡明显坏掉 ──
      console.log(`[eval:import] 步骤 ${r.steps.length} 章 | 参数 ${r.params.length} | 坑 ${r.lessons.length} | 缺口 ${r.gaps.length}`)
      console.log(`[eval:import] 保真 ${verbatim}/${fidelity.items.length} 逐字 · 未覆盖 ${fidelity.uncovered.length} 行 · 丢弃 ${r.dropped}`)
      for (const i of fidelity.items.filter((x) => !x.verbatim && !x.unverified)) {
        console.log(`[eval:import]   改写过: ${i.rendered.slice(0, 100)}`)
        console.log(`[eval:import]     最近原文: ${i.closest?.slice(0, 100)}`)
      }

      expect(r.steps.length).toBeGreaterThan(5)
      expect(r.params.length).toBeGreaterThanOrEqual(10)
      expect(r.lessons.length).toBeGreaterThanOrEqual(3)
      // 实测基线：flash 两次 13/13、一次 15/16。掉到 80% 以下说明提示词或
      // schema 退化了
      expect(verbatim / Math.max(fidelity.items.length, 1)).toBeGreaterThanOrEqual(0.8)
    },
  )
})

describe.skipIf(!enabled)('评测：差异（模式 A）', () => {
  it(
    'PL 的一段话 → 正确的参数差异 + 主动提问',
    { timeout: 180_000 },
    async () => {
      const llm = createLlm(new LlmSettings(new Store(openDb({ path: ':memory:' })), process.env))
      const imported = await importMaterial(llm, persona, importPrompt, { material: wiki, environments: [] })
      const params: Param[] = imported.params.map((p) => ({ ...p, source: 'base', secret: false }))

      const steps: Step[] = []
      let idx = 0
      for (const s of imported.steps) {
        for (const c of s.children ?? []) {
          steps.push({
            id: `s${idx}`,
            runbookId: 'rbk',
            parentId: s.title,
            orderKey: `k${idx}`,
            kind: c.kind === 'note' ? 'manual' : c.kind,
            title: c.title,
            whyMd: c.whyMd ?? null,
            whySource: null,
            command: c.command ?? null,
            envId: null,
            expectation: (c.expectation as Step['expectation']) ?? null,
            probe: (c.probe as Step['probe']) ?? null,
            timeoutMs: c.timeoutMs ?? null,
            expectedMinutes: c.expectedMinutes ?? null,
            status: 'pending',
            startedAt: null,
            endedAt: null,
            actualMs: null,
            delegateTaskId: null,
            rev: 0,
            lineageKey: `lin_${idx}`,
            origin: 'base',
            editedBy: null,
            sourceRef: null,
            statusNote: null,
          })
          idx++
        }
      }

      const t0 = Date.now()
      const p = await proposeAdapt(llm, persona, adaptPrompt, { message: plMessage, params, steps, lessons: [] })
      console.log(`[eval:adapt] ${((Date.now() - t0) / 1000).toFixed(1)}s | 参数改 ${p.paramChanges.length} · 新参数 ${p.newParams.length} · 改命令 ${p.stepEdits.length} · 作废 ${p.obsolete.length} · 疑问 ${p.questions.length}`)
      for (const c of p.paramChanges) console.log(`[eval:adapt]   ${c.name} → ${c.to}`)
      for (const q of p.questions) console.log(`[eval:adapt]   问: ${q}`)

      // 硬门槛：核心 IP 都改到了，且会主动问
      const changed = new Map(p.paramChanges.map((c) => [c.name, c.to]))
      expect([...changed.values()].join(' ')).toContain('10.0.5.21')
      expect([...changed.values()].join(' ')).toContain('10.0.5.22')
      expect(changed.get('MODEL_PATH') ?? [...changed.entries()].find(([k]) => k.includes('MODEL'))?.[1]).toContain('Qwen3-32B')
      expect(p.questions.length).toBeGreaterThanOrEqual(1)
    },
  )
})
