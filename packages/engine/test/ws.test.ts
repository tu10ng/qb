import { describe, expect, it, vi } from 'vitest'
import { createWsHandler } from '../src/web/ws.ts'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** 造一个记录写入内容的假 socket。 */
function fakeSocket() {
  const written: Buffer[] = []
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const socket = {
    write(data: Buffer | string) {
      written.push(typeof data === 'string' ? Buffer.from(data) : data)
      return true
    },
    end(data?: string) {
      if (data !== undefined) written.push(Buffer.from(data))
    },
    destroy: vi.fn(),
    unshift: vi.fn(),
    on(event: string, cb: (...a: unknown[]) => void) {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
      return this
    },
  } as unknown as Duplex

  return {
    socket,
    written,
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args)
    },
  }
}

function fakeReq(key = 'dGhlIHNhbXBsZSBub25jZQ=='): IncomingMessage {
  return { headers: { 'sec-websocket-key': key } } as unknown as IncomingMessage
}

/** 解出文本帧的 payload，顺带校验帧头。 */
function decodeTextFrame(buf: Buffer): string {
  expect(buf[0]).toBe(0x81) // FIN + text opcode
  const lenByte = buf[1]!
  expect(lenByte & 0x80).toBe(0) // 服务端不得掩码

  if (lenByte < 126) return buf.subarray(2, 2 + lenByte).toString('utf8')
  if (lenByte === 126) {
    const len = buf.readUInt16BE(2)
    return buf.subarray(4, 4 + len).toString('utf8')
  }
  const len = Number(buf.readBigUInt64BE(2))
  return buf.subarray(10, 10 + len).toString('utf8')
}

describe('createWsHandler', () => {
  it('完成握手并回 101', () => {
    const ws = createWsHandler()
    const { socket, written } = fakeSocket()

    ws.handler(fakeReq(), socket, Buffer.alloc(0))

    const response = written[0]!.toString()
    expect(response).toContain('HTTP/1.1 101 Switching Protocols')
    expect(response).toContain('Upgrade: websocket')
    // RFC 6455 的示例 key 对应的 accept 值
    expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('缺少 key 时拒绝握手', () => {
    const ws = createWsHandler()
    const { socket, written } = fakeSocket()

    ws.handler({ headers: {} } as unknown as IncomingMessage, socket, Buffer.alloc(0))

    expect(written[0]!.toString()).toContain('400 Bad Request')
    expect(ws.clientCount).toBe(0)
  })

  it('发送 JSON 消息', () => {
    const ws = createWsHandler()
    const { socket, written } = fakeSocket()
    ws.handler(fakeReq(), socket, Buffer.alloc(0))

    ws.broadcast({ type: 'step.output', text: 'hello' })

    expect(decodeTextFrame(written[1]!)).toBe('{"type":"step.output","text":"hello"}')
  })

  describe('帧长度编码', () => {
    it('短帧（< 126 字节）', () => {
      const ws = createWsHandler()
      const { socket, written } = fakeSocket()
      ws.handler(fakeReq(), socket, Buffer.alloc(0))

      ws.broadcast('x'.repeat(10))
      const decoded = decodeTextFrame(written[1]!)
      expect(JSON.parse(decoded)).toBe('x'.repeat(10))
    })

    it('中等帧（需要 16 位长度）', () => {
      const ws = createWsHandler()
      const { socket, written } = fakeSocket()
      ws.handler(fakeReq(), socket, Buffer.alloc(0))

      const payload = 'y'.repeat(1000)
      ws.broadcast(payload)
      expect(written[1]![1]).toBe(126)
      expect(JSON.parse(decodeTextFrame(written[1]!))).toBe(payload)
    })

    it('大帧（需要 64 位长度）', () => {
      const ws = createWsHandler()
      const { socket, written } = fakeSocket()
      ws.handler(fakeReq(), socket, Buffer.alloc(0))

      // 命令输出很容易超过 64KB（比如 pip install 的日志）
      const payload = 'z'.repeat(70_000)
      ws.broadcast(payload)
      expect(written[1]![1]).toBe(127)
      expect(JSON.parse(decodeTextFrame(written[1]!))).toBe(payload)
    })
  })

  it('广播到多个客户端', () => {
    const ws = createWsHandler()
    const a = fakeSocket()
    const b = fakeSocket()
    ws.handler(fakeReq(), a.socket, Buffer.alloc(0))
    ws.handler(fakeReq(), b.socket, Buffer.alloc(0))

    expect(ws.clientCount).toBe(2)
    ws.broadcast({ n: 1 })

    expect(decodeTextFrame(a.written[1]!)).toBe('{"n":1}')
    expect(decodeTextFrame(b.written[1]!)).toBe('{"n":1}')
  })

  it('客户端发 close 帧后剔除连接', () => {
    const ws = createWsHandler()
    const { socket, emit } = fakeSocket()
    ws.handler(fakeReq(), socket, Buffer.alloc(0))
    expect(ws.clientCount).toBe(1)

    emit('data', Buffer.from([0x88, 0x00]))
    expect(ws.clientCount).toBe(0)
  })

  it('响应 ping', () => {
    const ws = createWsHandler()
    const { socket, written, emit } = fakeSocket()
    ws.handler(fakeReq(), socket, Buffer.alloc(0))

    emit('data', Buffer.from([0x89, 0x00]))

    const pong = written[written.length - 1]!
    expect(pong[0]).toBe(0x8a)
  })

  it('socket 出错时剔除连接', () => {
    const ws = createWsHandler()
    const { socket, emit } = fakeSocket()
    ws.handler(fakeReq(), socket, Buffer.alloc(0))

    emit('error', new Error('连接断了'))
    expect(ws.clientCount).toBe(0)
  })

  it('onConnect 回调被调用', () => {
    const onConnect = vi.fn()
    const ws = createWsHandler({ onConnect })
    const { socket } = fakeSocket()

    ws.handler(fakeReq(), socket, Buffer.alloc(0))
    expect(onConnect).toHaveBeenCalledOnce()
  })
})
