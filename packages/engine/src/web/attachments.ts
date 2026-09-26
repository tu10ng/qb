/**
 * 截图证据的存取。
 *
 * 文件按内容哈希命名：同一张图贴两次只存一份；文件名由我们生成，
 * 读取时再按白名单格式校验一次，路径穿越无从发生。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const MEDIA_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([media, ext]) => [ext, media]),
)

/**
 * 单张上限。终端截图通常几百 KB；再大多半是误贴了照片。
 * 注意 HTTP 层的请求体上限是 8MB：base64 有 4/3 膨胀，5MB 原始数据
 * 编码后约 6.7MB，留出余量，别让"图片太大"变成莫名其妙的"请求体超限"。
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const NAME_RE = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/

/** 各格式的文件头（魔数）。声明的 MIME 与内容对不上就拒绝。 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF',
  webp: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}

export class AttachmentError extends Error {}

export class Attachments {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** 存一张 base64 图片，返回文件名。 */
  async saveImage(base64: string, mediaType: string): Promise<string> {
    const ext = TYPES[mediaType]
    if (ext === undefined) {
      throw new AttachmentError(`不支持的图片格式：${mediaType}（支持 png / jpeg / webp / gif）`)
    }
    // 兼容 data URL（浏览器 FileReader 给的就是这种）
    const raw = base64.replace(/^data:[^;]+;base64,/, '')
    const bytes = Buffer.from(raw, 'base64')
    if (bytes.length === 0) throw new AttachmentError('图片是空的')
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new AttachmentError(`图片太大（${Math.round(bytes.length / 1024)} KB），上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    }
    if (!MAGIC[ext]!(bytes)) {
      throw new AttachmentError(`内容不是声明的 ${mediaType}，请重新截图或换一张`)
    }

    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, name)
    if (!existsSync(path)) await writeFile(path, bytes)
    return name
  }

  async read(name: string): Promise<{ data: Buffer; mediaType: string } | null> {
    if (!NAME_RE.test(name)) return null
    const ext = name.slice(name.lastIndexOf('.') + 1)
    try {
      return { data: await readFile(join(this.dir, name)), mediaType: MEDIA_BY_EXT[ext]! }
    } catch {
      return null
    }
  }
}
