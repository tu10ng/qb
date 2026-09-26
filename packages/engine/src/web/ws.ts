import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * 最小 WebSocket 服务端。
 *
 * dsh 的 registerUpgrade 给的是裸 socket，握手和分帧要自己做。
 * 我们只需要"服务端往浏览器推 JSON"，所以：
 * - 只实现文本帧与 close/ping/pong
 * - 发送端不做掩码（RFC 6455 要求服务端不掩码）
 * - 接收端只处理客户端的 close 与 ping，忽略其余内容
 *
 * 引 ws 包也可以，但那会让 QB 插件多一个需要在 dsh 的 profile 里
 * 解析的运行时依赖；这段代码不到一百行且没有分支复杂度。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsClient {
  send(data: unknown): void
  close(): void
  readonly closed: boolean
}

export interface WsServerOptions {
  onConnect?: (client: WsClient, req: IncomingMessage) => void
  onClose?: (client: WsClient) => void
  /** 握手前的检查；返回非 null 即拒绝。挡跨站网页来读广播。 */
  guard?: (req: IncomingMessage) => string | null
}

export function createWsHandler(opts: WsServerOptions = {}) {
  const clients = new Set<WsClient>()

  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (opts.guard !== undefined && opts.guard(req) !== null) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    )

    let closed = false
    const client: WsClient = {
      get closed() {
        return closed
      },
      send(data: unknown) {
        if (closed) return
        try {
          socket.write(encodeTextFrame(JSON.stringify(data)))
        } catch {
          cleanup()
        }
      },
      close() {
        if (closed) return
        try {
          socket.write(Buffer.from([0x88, 0x00])) // close frame
        } catch {
          // 对端已断开，忽略
        }
        cleanup()
      },
    }

    const cleanup = (): void => {
      if (closed) return
      closed = true
      clients.delete(client)
      opts.onClose?.(client)
      socket.destroy()
    }

    clients.add(client)
    socket.on('error', cleanup)
    socket.on('close', cleanup)

    // 只解析控制帧：客户端的 close 要回应，ping 要 pong。
    // 业务上浏览器不往这条连接发数据，所以不实现完整的分片重组。
    socket.on('data', (buf: Buffer) => {
      if (buf.length < 2) return
      const opcode = buf[0]! & 0x0f
      if (opcode === 0x8) {
        cleanup()
      } else if (opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00])) // pong
      }
    })

    if (head.length > 0) socket.unshift(head)
    opts.onConnect?.(client, req)
  }

  return {
    handler,
    /** 向所有连接广播。断开的连接会被自动剔除。 */
    broadcast(data: unknown): void {
      for (const c of clients) {
        if (c.closed) clients.delete(c)
        else c.send(data)
      }
    },
    get clientCount(): number {
      return clients.size
    },
  }
}

/** 编码一个不掩码的文本帧。 */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length

  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }

  return Buffer.concat([header, payload])
}
