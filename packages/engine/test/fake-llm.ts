import type { Llm, PurposeStatus, StructuredCall, StructuredResult } from '../src/llm/port.ts'

/**
 * 测试用 Llm：返回预设的"模型原始输出"，并像真实实现一样经 schema 校验
 * ——这样宽容校验（.catch、坏项丢弃）也在测试覆盖之内。
 */
export class FakeLlm implements Llm {
  readonly calls: Array<StructuredCall<unknown>> = []
  private respond: (call: StructuredCall<unknown>) => unknown | Promise<unknown>

  constructor(respond: unknown | ((call: StructuredCall<unknown>) => unknown | Promise<unknown>)) {
    this.respond = typeof respond === 'function' ? (respond as (c: StructuredCall<unknown>) => unknown) : () => respond
  }

  async structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    this.calls.push(call as StructuredCall<unknown>)
    const raw = await this.respond(call as StructuredCall<unknown>)
    call.onPartial?.(raw)
    return { output: call.schema.parse(raw), model: 'fake-model', profileName: 'fake', attempts: 1, ms: 1 }
  }

  status(): PurposeStatus {
    return { ok: true, profileId: 'fake', profileName: 'fake', reason: null }
  }
}
