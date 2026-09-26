/**
 * QB 调模型的唯一入口。
 *
 * 上层（起草、导入、诊断……）只认这个接口，不 import `ai` / `@ai-sdk/*`。
 * 实现见 ./index.ts；测试里用替身。依据：docs/adr/0002-llm-via-ai-sdk.md。
 */

import type { z } from 'zod'
import type { Purpose } from './profiles.ts'

export interface ImageInput {
  data: Uint8Array
  mediaType: string
}

export interface StructuredCall<T> {
  purpose: Purpose
  /** 输出的名字，给模型当提示，也用在错误信息里。 */
  name: string
  system: string
  prompt: string
  /** 截图等图片证据。 */
  images?: ImageInput[]
  /**
   * 输出 schema。给模型看的是严格契约；校验时宽容——非关键字段 .catch()
   * 兜底、坏的单项丢弃，结构性失败重试一次。
   */
  schema: z.ZodType<T>
  signal?: AbortSignal
  /** 部分结果（未校验），用来让步骤边生成边出现。 */
  onPartial?: (partial: unknown) => void
}

export interface StructuredResult<T> {
  output: T
  /** 端点报告的模型 id。 */
  model: string
  profileName: string
  attempts: number
  ms: number
}

export type LlmErrorKind =
  | 'not_configured'
  | 'auth'
  | 'not_found'
  | 'thinking_conflict'
  | 'rejected'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'shape'
  | 'unsupported'

/** 给人看的模型错误：说清是哪个档案、出了什么事、该怎么办。不含密钥。 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status: number | null

  constructor(kind: LlmErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = status
  }
}

export interface PurposeStatus {
  ok: boolean
  profileId: string | null
  profileName: string | null
  reason: string | null
}

export interface Llm {
  structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>>
  /** 某个用途现在用哪个档案；界面据此提示"还没配置模型"。 */
  status(purpose: Purpose): PurposeStatus
}
