import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectDocFormat, orgInline, parseDocument, parseMarkdown, parseOrg, type DocBlock } from '../src/doc-import.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8')

/** 块树展平成 [深度, 种类, 标题]，断言好写。 */
function flat(blocks: DocBlock[], depth = 0): Array<[number, string, string]> {
  return blocks.flatMap((b) => [[depth, b.kind, b.title] as [number, string, string], ...flat(b.children ?? [], depth + 1)])
}

function find(blocks: DocBlock[], pred: (b: DocBlock) => boolean): DocBlock | undefined {
  for (const b of blocks) {
    if (pred(b)) return b
    const hit = find(b.children ?? [], pred)
    if (hit !== undefined) return hit
  }
  return undefined
}

describe('格式识别', () => {
  it('按文件名，没有文件名按内容', () => {
    expect(detectDocFormat('', 'a.org')).toBe('org')
    expect(detectDocFormat('', 'a.md')).toBe('md')
    expect(detectDocFormat('* 标题\n#+begin_src sh\nls\n#+end_src')).toBe('org')
    expect(detectDocFormat('# 标题\n```sh\nls\n```')).toBe('md')
  })
})

describe('markdown：用户自己的部署笔记', () => {
  const r = parseMarkdown(fixture('deploy-note.md'), { resolveImage: (u) => (u.includes('e4431e9d') ? '/qb/api/attachments/a.png' : null) })

  it('有几个一级标题就是几个顶层章节（笔记里记了三件事）', () => {
    expect(r.title).toBeNull()
    expect(r.blocks.map((b) => [b.kind, b.title])).toEqual([
      ['section', '用2和3号卡部署qwen3.6 27b, 最小运行, 速度为10tps'],
      ['section', '测试vllm速度'],
      ['section', 'pd分离部署'],
    ])
  })

  it('只有一个一级标题时它是文档标题，章节从下一级开始', () => {
    const one = parseMarkdown('# 部署\n## 准备\n```sh\nls\n```\n## 启动\ntext')
    expect(one.title).toBe('部署')
    expect(one.blocks.map((b) => b.title)).toEqual(['准备', '启动'])
  })

  it('标题照原文嵌套成多层章节', () => {
    const rows = flat(r.blocks)
    expect(rows).toContainEqual([2, 'section', '创建vllm-ascend的docker'])
    expect(rows).toContainEqual([3, 'section', '双卡启动大概需要4-6分钟'])
    expect(rows).toContainEqual([1, 'section', '关闭docker'])
  })

  it('命令逐字保留（续行、缩进都在），不拆', () => {
    const run = find(r.blocks, (b) => b.kind === 'command' && (b.command ?? '').startsWith('docker run'))!
    expect(run.command!.split('\n')).toHaveLength(8)
    expect(run.command).toContain('--device=/dev/davinci_manager')
    expect(run.lang).toBe('bash')
    // 一组 export 连同注释是同一条命令（原文就是一段）
    const env = find(r.blocks, (b) => b.kind === 'command' && (b.command ?? '').includes('HCCL_BUFFSIZE'))!
    expect(env.command).toContain('export MODEL_PATH="/home/weight/Qwen3.6-27B/"')
  })

  it('日志、关键字、带提示符的终端记录是回显，不是命令', () => {
    for (const t of ['enable_prefix_caching', 'Application startup complete.']) {
      expect(find(r.blocks, (b) => b.command === t)?.kind).toBe('output')
    }
    const transcript = find(r.blocks, (b) => (b.command ?? '').includes('[root@gpu-node1 ~]#'))!
    expect(transcript.kind).toBe('output')
  })

  it('python 代码块是代码（只复制）', () => {
    expect(find(r.blocks, (b) => (b.command ?? '').startsWith('os.system('))).toMatchObject({ kind: 'code', lang: 'python' })
  })

  it('紧跟在命令后面的截图挂成参考回显；带不上的图如实标出', () => {
    const images = find(r.blocks, (b) => b.command === 'docker images')!
    expect(images.refMd).toBe('![image](/qb/api/attachments/a.png)')
    const serve = find(r.blocks, (b) => (b.command ?? '').startsWith('vllm serve ${MODEL_PATH}'))!
    expect(serve.refMd).toContain('图片没导入')
    expect(r.stats.missingImages).toBe(3)
    expect(r.images).toHaveLength(4)
  })

  it('空代码块丢掉；说明文字是文字块，标题取第一行', () => {
    expect(find(r.blocks, (b) => b.kind === 'command' && (b.command ?? '').trim() === '')).toBeUndefined()
    const note = find(r.blocks, (b) => b.kind === 'note' && (b.bodyMd ?? '').includes('ASCEND_RT_VISIBLE_DEVICES'))!
    expect(note.title).toBe('重点是 ASCEND_RT_VISIBLE_DEVICES 和 MODEL_PATH')
    expect(note.titleAuto).toBe(true)
  })

  it('紧跟命令的 text 围栏挂成它的参考回显', () => {
    const md = '# a\n```sh\nnpu-smi info\n```\n```text\n| NPU 0 | OK |\n```'
    const cmd = find(parseMarkdown(md).blocks, (b) => b.kind === 'command')!
    expect(cmd.refMd).toBe('```text\n| NPU 0 | OK |\n```')
  })
})

describe('org-mode：用户的知识笔记', () => {
  const r = parseOrg(fixture('notes.org'))

  it('TODO 与优先级不进标题；唯一的一级标题当文档标题', () => {
    expect(r.title).toBe('vllm')
  })

  it('链接、表格、行内代码转成 markdown', () => {
    const table = find(r.blocks, (b) => b.kind === 'note' && (b.bodyMd ?? '').includes('a100'))!
    expect(table.bodyMd).toContain('|-------------------|-------|-----------------|')
    expect(orgInline('用 =vllm serve= 启动，见 [[https://docs.vllm.ai][vllm 文档]]')).toBe('用 `vllm serve` 启动，见 [vllm 文档](https://docs.vllm.ai)')
    expect(orgInline('[[file:./a.png]]')).toBe('![](./a.png)')
  })

  it('#+begin_src sh 是命令，后面紧跟的 #+begin_example 是它的参考回显；别的语言是代码', () => {
    const smi = find(r.blocks, (b) => b.command === 'npu-smi info')!
    expect(smi.kind).toBe('command')
    expect(smi.refMd).toContain('npu-smi 24.1.rc2')
    expect(find(r.blocks, (b) => (b.command ?? '').startsWith('FINISHED_ABORTED'))).toMatchObject({ kind: 'code', lang: 'flowgraph' })
  })

  it('多层标题嵌套成多层章节（参考类章节只有文字，没有命令）', () => {
    const rows = flat(r.blocks)
    expect(rows).toContainEqual([0, 'section', '(vllm ref)'])
    expect(rows).toContainEqual([2, 'section', 'compute intensity'])
  })
})

describe('parseDocument', () => {
  it('按格式分派', () => {
    expect(parseDocument('* A\n** B', 'org').blocks[0]).toMatchObject({ kind: 'section', title: 'B' })
    expect(parseDocument('# A\n## B\ntext', 'md').blocks[0]).toMatchObject({ kind: 'section', title: 'B' })
  })
})
