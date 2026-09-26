/**
 * 定位起草慢的原因：逐个变量对照。
 *
 * 用法：node scripts/bench-draft.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.QB_LLM_BASE_URL
const KEY = process.env.QB_LLM_API_KEY
const MODEL = process.env.QB_LLM_MODEL

const persona = readFileSync(join(root, 'packages/engine/prompts/qb-persona.md'), 'utf8')
const schema = JSON.parse(readFileSync(join(root, '.run/schema.json'), 'utf8'))

const TASK = `把下面这个任务展开成一份 runbook。

# 任务

**标题**：在 X 集群把 vLLM PD 分离部署跑起来

模型 Qwen2.5-72B-Instruct，prefill 2 卡、decode 6 卡，vLLM 0.11.x。对外只暴露 proxy。
完成定义：proxy 能正常转发请求，压测 QPS 不低于现有单体部署。

# 执行环境

- **local**：系统 Linux，shell bash，GPU 8× NVIDIA H800，CUDA 12.4

---

**直接调用 \`propose_runbook\`，不要先写分析。**`

const TINY_SCHEMA = {
  name: 'propose_runbook',
  description: '提交 runbook',
  parameters: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, value: { type: 'string' } },
          required: ['key', 'value'],
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string' },
            kind: { type: 'string', enum: ['command', 'check', 'wait', 'manual', 'note'] },
            title: { type: 'string' },
            why: { type: 'string' },
            command: { type: 'string' },
          },
          required: ['section', 'kind', 'title'],
        },
      },
    },
    required: ['assumptions', 'steps'],
  },
}

const SHORT_PERSONA = `你是 QB。你把一句模糊的目标展开成一份工程师能跟着做完的 runbook。

要求：命令精确可直接运行；每步有一句"为什么"；给出可验证的预期和耗时估计；
用 section 分章节（准备/启动/验证/交接）；8-20 步。
信息不全就写进 assumptions，不要追问。`

async function bench(label, { system, schema: sc, maxTokens = 32768 }) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: TASK }],
        tools: [{ name: sc.name, description: sc.description, input_schema: sc.parameters }],
        tool_choice: { type: 'tool', name: sc.name },
      }),
      signal: AbortSignal.timeout(300_000),
    })
    const j = await r.json()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const tu = (j.content ?? []).find((b) => b.type === 'tool_use')
    const th = (j.content ?? []).filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('')
    console.log(
      `${secs.padStart(6)}s  ${label.padEnd(34)} stop=${j.stop_reason} thinking=${String(th.length).padStart(6)} steps=${tu?.input?.steps?.length ?? '-'}`,
    )
  } catch (e) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${label.padEnd(34)} FAILED: ${e.message}`)
  }
}

console.log('persona 长度:', persona.length, '| 真实 schema 长度:', JSON.stringify(schema).length)
console.log('tiny schema 长度:', JSON.stringify(TINY_SCHEMA).length, '| short persona 长度:', SHORT_PERSONA.length)
console.log()

const which = process.argv[2] ?? 'all'
if (which === 'all' || which === '1') await bench('短 persona + 小 schema', { system: SHORT_PERSONA, schema: TINY_SCHEMA })
if (which === 'all' || which === '2') await bench('短 persona + 真 schema', { system: SHORT_PERSONA, schema })
if (which === 'all' || which === '3') await bench('真 persona + 小 schema', { system: persona, schema: TINY_SCHEMA })
if (which === 'all' || which === '4') await bench('真 persona + 真 schema', { system: persona, schema })
