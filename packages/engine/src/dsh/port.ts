/**
 * QB 与宿主 harness 之间的唯一契约。
 *
 * 上层代码只认这个接口，不认 dsh。换 harness（Claude Agent SDK、
 * 自研 loop）只需另写一个实现。见 docs/adr/0001-dsh-api-surface.md。
 */

export interface RunRequest {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  stdin?: string
}

export interface RunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/**
 * 增量输出块。
 *
 * 注意：流式回显时 stdout 与 stderr 是合并的（dsh 的 readOutput 返回
 * 合并后的 delta）。需要分流的场景用 RunResult，它区分两者。
 */
export interface OutputChunk {
  text: string
  /** 截断导致有字节丢失。UI 上要提示用户去看完整日志。 */
  lossy: boolean
  /** 发生截断时的完整输出落盘路径。 */
  spillPath?: string
}

/**
 * 一次正在进行的执行。
 *
 * wait 类步骤（起 vLLM 这种要几分钟的）用它：订阅输出、等待结束、
 * 或者在用户点"跳过"时 kill。
 */
export interface StreamingRun {
  /** 订阅增量输出，返回取消订阅的函数。 */
  onChunk(cb: (chunk: OutputChunk) => void): () => void
  /** 执行结束时 resolve。不会 reject——失败也是一种结果。 */
  readonly done: Promise<RunResult>
  /** 强制结束。返回是否真的发出了信号。 */
  kill(): boolean
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionRequest {
  messages: CompletionMessage[]
  /** 要求模型以该 JSON Schema 结构化输出（通过工具调用实现）。 */
  schema?: { name: string; description: string; parameters: unknown }
  maxTokens?: number
  signal?: AbortSignal
  /** 进度回调：模型思考/写入了多少字符。用于让用户知道它还活着。 */
  onProgress?: (p: { kind: 'thinking' | 'writing'; chars: number }) => void
}

export interface Completion {
  text: string
  /** schema 存在时的结构化结果。 */
  structured?: unknown
  /** 推理型模型的思考过程。不展示给用户，用于诊断起草质量。 */
  thinking?: string
  model: string
}

export interface Disposable {
  dispose(): void
}

/**
 * 宿主能力端口。
 */
export interface HostPort {
  /** 一次性执行，等结果。用于 command / check 步骤。 */
  runCommand(req: RunRequest): Promise<RunResult>

  /** 启动并返回句柄，可流式读输出。用于 wait 步骤和需要实时回显的场景。 */
  startCommand(req: RunRequest): StreamingRun

  /** 调模型。 */
  complete(req: CompletionRequest): Promise<Completion>

  /** 定时回调。用于就绪轮询、卡住检测、摘要。 */
  schedule(delayMs: number, fn: () => void): Disposable

  /** 宿主信息，用于启动器打印 URL 和自检。 */
  readonly info: { host: string; port: number }
}
