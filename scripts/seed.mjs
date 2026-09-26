/**
 * 造一份真实可跑的示例数据：vLLM PD 分离部署。
 *
 * 这是 M4 之前的临时手段——QB 起草功能（M3）上线后，runbook 由模型生成。
 * 用法：node scripts/seed.mjs
 */
const API = `http://127.0.0.1:${process.env.QB_PORT ?? 3080}/qb/api`

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const task = await post('/tasks', {
  title: 'X集群 PD分离部署',
  briefMd:
    '在 X 集群上把 vLLM 的 prefill/decode 分离部署跑起来。\n\n' +
    '模型用 Qwen2.5-72B，prefill 2 卡、decode 6 卡。\n' +
    '完成定义：proxy 能正常转发，压测 QPS 不低于现有单体部署。',
  expectedMinutes: 180,
})

await post(`/tasks/${task.id}/runbook`, {
  assumptions: [
    { key: '集群', value: 'X集群 (gpu-17 ~ gpu-20)', editedByUser: false },
    { key: '模型', value: 'Qwen2.5-72B-Instruct', editedByUser: false },
    { key: 'vLLM 版本', value: 'v0.11.x', editedByUser: false },
    { key: 'PD 配比', value: 'prefill 2 卡 / decode 6 卡', editedByUser: false },
  ],
  steps: [
    {
      kind: 'note',
      title: '1 准备',
      children: [
        {
          kind: 'command',
          title: '确认目标节点 GPU 空闲',
          whyMd: '有人在跑训练的话显存不够，起到一半才失败更浪费时间',
          whySource: 'skill「PD分离」§1',
          command: 'nvidia-smi --query-gpu=index,memory.used --format=csv',
          expectation: { kind: 'notContains', text: 'MiB, 8' },
          timeoutMs: 15000,
          expectedMinutes: 0.2,
        },
        {
          kind: 'command',
          title: '检查 vLLM 版本',
          whyMd: 'PD 分离对版本敏感，proxy 和 server 必须同版本',
          whySource: 'skill「PD分离」§1',
          command: 'python -c "import vllm; print(vllm.__version__)"',
          expectation: { kind: 'regex', pattern: '0\\.11\\.', flags: '' },
          timeoutMs: 30000,
          expectedMinutes: 0.5,
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
          command:
            'vllm serve $MODEL --port 8100 --tensor-parallel-size 6 \\\n' +
            "  --kv-transfer-config '{\"kv_connector\":\"PyNcclConnector\",\"kv_role\":\"kv_consumer\"}'",
          expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
          timeoutMs: 600000,
          expectedMinutes: 8,
        },
        {
          kind: 'wait',
          title: '等 decode 就绪',
          whyMd: '加载 72B 权重要几分钟，QB 盯着健康检查',
          command: 'echo 等待中',
          probe: { kind: 'http', url: 'http://127.0.0.1:8100/health', expectStatus: 200 },
          timeoutMs: 600000,
          expectedMinutes: 8,
        },
        {
          kind: 'command',
          title: '拉起 prefill 实例',
          whyMd: 'kv_producer 侧，卡数与 decode 不同是有意为之',
          whySource: 'skill「PD分离」§3',
          command:
            'vllm serve $MODEL --port 8200 --tensor-parallel-size 2 \\\n' +
            "  --kv-transfer-config '{\"kv_connector\":\"PyNcclConnector\",\"kv_role\":\"kv_producer\"}'",
          expectation: { kind: 'contains', text: 'Started server', caseSensitive: true },
          timeoutMs: 600000,
          expectedMinutes: 6,
        },
        {
          kind: 'command',
          title: '起 proxy',
          whyMd: '对外只暴露 proxy，上游不需要知道 PD 拆分',
          command: 'python -m vllm.entrypoints.disaggregated_proxy --port 8000',
          expectation: { kind: 'contains', text: 'Uvicorn running', caseSensitive: true },
          timeoutMs: 60000,
          expectedMinutes: 1,
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
          command:
            'curl -s http://127.0.0.1:8000/v1/completions \\\n' +
            '  -H "Content-Type: application/json" \\\n' +
            '  -d \'{"model":"qwen","prompt":"你好","max_tokens":16}\'',
          expectation: { kind: 'contains', text: 'choices', caseSensitive: true },
          timeoutMs: 60000,
          expectedMinutes: 0.5,
        },
        {
          kind: 'manual',
          title: '压测并对比 QPS',
          whyMd: '完成定义要求不低于现有单体部署',
          expectation: { kind: 'manual', description: 'QPS 不低于单体部署的基线' },
          expectedMinutes: 30,
        },
      ],
    },
    {
      kind: 'note',
      title: '4 交接',
      children: [
        {
          kind: 'manual',
          title: '把部署参数记到团队文档',
          expectedMinutes: 10,
        },
      ],
    },
  ],
})

console.log(`已创建任务 ${task.id}`)
console.log(`打开 http://127.0.0.1:${process.env.QB_PORT ?? 3080}/qb/`)
