/**
 * 假模型端点：验证起草链路而不依赖真实模型。
 *
 * 说 OpenAI Chat Completions 协议，收到请求后返回一份固定的
 * 工具调用结果。用来端到端验证提示词组装 → 工具调用 → 校验 → 落库。
 *
 * 用法：node scripts/fake-llm.mjs [port]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 4099)

const RUNBOOK = {
  assumptions: [
    { key: '集群', value: 'X集群 (gpu-17)' },
    { key: '模型', value: 'Qwen2.5-72B-Instruct' },
  ],
  steps: [
    {
      kind: 'note',
      title: '1 准备',
      children: [
        {
          kind: 'command',
          title: '确认 GPU 空闲',
          whyMd: '显存不够时起到一半才失败更浪费时间',
          command: 'nvidia-smi --query-gpu=memory.used --format=csv',
          expectation: { kind: 'exitCode', code: 0 },
          timeoutMs: 15000,
          expectedMinutes: 0.2,
        },
      ],
    },
    {
      kind: 'note',
      title: '2 启动',
      children: [
        {
          kind: 'command',
          title: '拉起 decode 实例',
          whyMd: 'decode 侧先起，prefill 才能注册 KV 通道',
          whySource: 'skill「PD分离」§3',
          command: 'vllm serve $MODEL --port 8100 --tensor-parallel-size 6',
          expectation: { kind: 'contains', text: 'Started server' },
          timeoutMs: 600000,
          expectedMinutes: 8,
        },
        {
          kind: 'wait',
          title: '等 decode 就绪',
          probe: { kind: 'http', url: 'http://127.0.0.1:8100/health' },
          timeoutMs: 600000,
          expectedMinutes: 8,
        },
      ],
    },
    {
      kind: 'note',
      title: '3 验证',
      children: [
        {
          kind: 'check',
          title: '冒烟一次请求',
          command: 'curl -s http://127.0.0.1:8000/v1/models',
          expectation: { kind: 'contains', text: 'data' },
          timeoutMs: 30000,
        },
      ],
    },
  ],
}

let lastPrompt = ''

const server = createServer((req, res) => {
  if (req.url === '/__last_prompt') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ prompt: lastPrompt }))
    return
  }

  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      lastPrompt = (parsed.messages ?? []).map((m) => m.content).join('\n---\n')

      const toolName = parsed.tools?.[0]?.function?.name ?? 'propose_runbook'

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'fake-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(RUNBOOK) },
                  },
                ],
              },
            },
          ],
        }),
      )
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-llm listening on http://127.0.0.1:${PORT}`)
})
