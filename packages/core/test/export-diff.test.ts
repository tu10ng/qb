import { describe, expect, it } from 'vitest'
import { diffCount, diffLines } from '../src/diff.ts'
import { exportMarkdown } from '../src/export-md.ts'
import { parseMarkdown } from '../src/doc-import.ts'
import type { Param, Step } from '../src/schema.ts'

function step(p: Partial<Step> & { id: string; kind: Step['kind'] }): Step {
  return {
    runbookId: 'r',
    parentId: null,
    orderKey: 'V',
    title: p.id,
    titleAuto: false,
    whyMd: null,
    whySource: null,
    command: null,
    bodyMd: null,
    lang: null,
    refMd: null,
    envId: null,
    expectation: null,
    probe: null,
    timeoutMs: null,
    expectedMinutes: null,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    actualMs: null,
    delegateTaskId: null,
    rev: 0,
    lineageKey: null,
    origin: 'human',
    editedBy: null,
    sourceRef: null,
    statusNote: null,
    shareOutput: false,
    ...p,
  }
}

describe('diffLines：回显对比', () => {
  it('完全一样 → 没有增删', () => {
    expect(diffCount(diffLines('a\nb', 'a\nb'))).toBe(0)
  })

  it('中间变了一行：只报那一行', () => {
    const ops = diffLines('GPU KV cache size: 402,318 tokens\nStarted', 'GPU KV cache size: 381,000 tokens\nStarted')
    expect(ops).toEqual([
      { kind: 'del', text: 'GPU KV cache size: 402,318 tokens' },
      { kind: 'add', text: 'GPU KV cache size: 381,000 tokens' },
      { kind: 'same', text: 'Started' },
    ])
  })

  it('多了几行 / 少了几行', () => {
    const ops = diffLines('a\nc', 'a\nb\nc')
    expect(ops.map((o) => o.kind)).toEqual(['same', 'add', 'same'])
    expect(diffCount(diffLines('a\nb\nc', 'a'))).toBe(2)
  })

  it('很长的日志不卡死：退化成整段替换', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    expect(diffCount(diffLines(a, b))).toBe(6000)
  })
})

describe('exportMarkdown：手册导出去', () => {
  const machine: Param = { name: '机器195', value: '10.9.8.195', valueLabel: 'IP', source: 'mine', secret: false, fields: [{ key: '密码', value: 'Fake@123', secret: true }] }
  const steps = [
    step({ id: 'sec', kind: 'section', title: '建容器' }),
    step({ id: 'n', kind: 'note', parentId: 'sec', bodyMd: '一般有人下载过，先看看' }),
    step({ id: 'c', kind: 'command', parentId: 'sec', title: 'docker images', titleAuto: true, command: 'ssh {{机器195}} docker images # {{机器195.密码}}', lang: 'bash', refMd: '![参考](/qb/api/attachments/x.png)' }),
    step({ id: 'sub', kind: 'section', parentId: 'sec', title: '看日志' }),
    step({ id: 'o', kind: 'output', parentId: 'sub', command: 'Application startup complete.' }),
    step({ id: 'm', kind: 'manual', title: '找 PL 确认用哪两张卡' }),
  ]

  it('章节成标题、命令成围栏（参数渲染、secret 打码）、回显成 text 围栏', () => {
    const md = exportMarkdown('部署 qwen', steps, [machine])
    expect(md).toContain('# 部署 qwen')
    expect(md).toContain('## 建容器')
    expect(md).toContain('### 看日志')
    expect(md).toContain('```bash\nssh 10.9.8.195 docker images # ***\n```')
    expect(md).toContain('```text\nApplication startup complete.\n```')
    expect(md).toContain('**找 PL 确认用哪两张卡**')
    expect(md).not.toContain('Fake@123')
    // 自动取的标题不重复写一遍
    expect(md).not.toContain('**docker images**')
  })

  it('导出再导入：结构回得来', () => {
    const md = exportMarkdown('部署 qwen', steps, [machine], { renderParams: false })
    const back = parseMarkdown(md)
    expect(back.title).toBe('部署 qwen')
    const kinds: string[] = []
    const walk = (bs: typeof back.blocks): void => {
      for (const b of bs) {
        kinds.push(b.kind)
        walk(b.children ?? [])
      }
    }
    walk(back.blocks)
    expect(kinds).toEqual(['section', 'note', 'command', 'section', 'output', 'note'])
  })

  it('正文里有 ``` 时围栏加长，不会提前闭合', () => {
    const md = exportMarkdown('x', [step({ id: 'c', kind: 'code', command: 'echo "```"', lang: 'bash' })], [])
    expect(md).toContain('````bash\necho "```"\n````')
  })
})
