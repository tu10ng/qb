import { describe, expect, it } from 'vitest'
import type { Step } from '../src/schema.ts'
import {
  ancestorsOf,
  canContain,
  depthOf,
  dropPosition,
  insertionAfter,
  insertionAtEnd,
  isContent,
  isDoable,
  isSection,
  movedPosition,
  positionOf,
  sectionOf,
  topLevelOf,
  withSubtrees,
} from '../src/tree.ts'

/**
 * 树上的位置计算。列表是先序的（同层按 orderKey），id 即名字。
 * 拖拽、插入、撤销都建立在这些函数上——位置算错，编辑全跟着错。
 */

function step(partial: Partial<Step> & { id: string }): Step {
  return {
    runbookId: 'rbk',
    parentId: null,
    orderKey: 'V',
    kind: 'command',
    title: partial.id,
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
    ...partial,
  }
}

/**
 * 文档（先序）：
 *   sec1
 *     a
 *     b
 *       b1
 *   sec2
 *     sub（章节）
 *       c
 *     d
 *   loose
 */
function doc(): { steps: Step[]; by: (id: string) => Step } {
  const steps = [
    step({ id: 'sec1', kind: 'section' }),
    step({ id: 'a', parentId: 'sec1', orderKey: 'k1' }),
    step({ id: 'b', parentId: 'sec1', orderKey: 'k2' }),
    step({ id: 'b1', parentId: 'b', kind: 'note', orderKey: 'k1' }),
    step({ id: 'sec2', kind: 'section', orderKey: 'W' }),
    step({ id: 'sub', parentId: 'sec2', kind: 'section', orderKey: 'k1' }),
    step({ id: 'c', parentId: 'sub', orderKey: 'k1' }),
    step({ id: 'd', parentId: 'sec2', orderKey: 'k2' }),
    step({ id: 'loose', orderKey: 'X' }),
  ]
  return { steps, by: (id) => steps.find((s) => s.id === id)! }
}

describe('块的种类', () => {
  it('章节、文字、代码、回显是内容；其余是要做的步骤', () => {
    expect(isSection({ kind: 'section' })).toBe(true)
    expect(isSection({ kind: 'note' })).toBe(false)
    for (const kind of ['section', 'note', 'code', 'output'] as const) {
      expect(isContent({ kind })).toBe(true)
      expect(isDoable({ kind })).toBe(false)
    }
    for (const kind of ['command', 'check', 'wait', 'manual', 'delegate', 'decision'] as const) expect(isDoable({ kind })).toBe(true)
  })

  it('章节里放什么都行；步骤下面能挂子步骤和说明，不能挂章节；内容块是叶子', () => {
    expect(canContain({ kind: 'section' }, { kind: 'section' })).toBe(true)
    expect(canContain({ kind: 'command' }, { kind: 'command' })).toBe(true)
    expect(canContain({ kind: 'command' }, { kind: 'note' })).toBe(true)
    expect(canContain({ kind: 'command' }, { kind: 'section' })).toBe(false)
    expect(canContain({ kind: 'note' }, { kind: 'command' })).toBe(false)
    expect(canContain({ kind: 'delegate' }, { kind: 'command' })).toBe(false)
    expect(canContain(null, { kind: 'section' })).toBe(true)
  })
})

describe('祖先 / 深度 / 所属章节', () => {
  it('沿父链走', () => {
    const { steps, by } = doc()
    expect(ancestorsOf(steps, by('c')).map((s) => s.id)).toEqual(['sub', 'sec2'])
    expect(depthOf(steps, by('c'))).toBe(2)
    expect(depthOf(steps, by('sec1'))).toBe(0)
    expect(topLevelOf(steps, by('c')).id).toBe('sec2')
  })

  it('所属章节是最近的那个；章节自己就是自己', () => {
    const { steps, by } = doc()
    expect(sectionOf(steps, by('c'))!.id).toBe('sub')
    expect(sectionOf(steps, by('b1'))!.id).toBe('sec1')
    expect(sectionOf(steps, by('sec2'))!.id).toBe('sec2')
    expect(sectionOf(steps, by('loose'))).toBeNull()
  })
})

describe('insertionAfter：插在界面上那条插入线的位置', () => {
  it('章节下面 = 这一章的第一项；折叠着的章节插在它后面', () => {
    const { steps, by } = doc()
    expect(insertionAfter(by('sec1'), steps)).toEqual({ parentId: 'sec1', afterId: null })
    expect(insertionAfter(by('sec1'), steps, true)).toEqual({ parentId: null, afterId: 'sec1' })
  })

  it('挂着子步骤的步骤下面 = 它的第一个子节点；叶子步骤下面 = 同层紧随其后', () => {
    const { steps, by } = doc()
    expect(insertionAfter(by('b'), steps)).toEqual({ parentId: 'b', afterId: null })
    expect(insertionAfter(by('a'), steps)).toEqual({ parentId: 'sec1', afterId: 'a' })
  })
})

describe('insertionAtEnd：落在最后一个最深的章节末尾', () => {
  it('空文档放最前', () => {
    expect(insertionAtEnd([])).toEqual({ parentId: null, afterId: null })
  })

  it('最后是散着的步骤时排在它后面', () => {
    const { steps } = doc()
    expect(insertionAtEnd(steps)).toEqual({ parentId: null, afterId: 'loose' })
  })

  it('最后一章的最后一项又是章节：钻进去', () => {
    const steps = [step({ id: 's', kind: 'section' }), step({ id: 'x', parentId: 's' }), step({ id: 'inner', parentId: 's', kind: 'section', orderKey: 'W' }), step({ id: 'y', parentId: 'inner' })]
    expect(insertionAtEnd(steps)).toEqual({ parentId: 'inner', afterId: 'y' })
    expect(insertionAtEnd([step({ id: 'only', kind: 'section' })])).toEqual({ parentId: 'only', afterId: null })
  })
})

describe('movedPosition', () => {
  it('上下移只在同层；到头了不能移', () => {
    const { steps, by } = doc()
    expect(movedPosition(steps, by('b'), 'up')).toEqual({ parentId: 'sec1', afterId: null })
    expect(movedPosition(steps, by('a'), 'up')).toBeNull()
    expect(movedPosition(steps, by('a'), 'down')).toEqual({ parentId: 'sec1', afterId: 'b' })
    expect(movedPosition(steps, by('b'), 'down')).toBeNull()
  })

  it('Tab 挂到上一个兄弟下面：兄弟是章节就放进章末，是步骤就成为它的子步骤', () => {
    const { steps, by } = doc()
    expect(movedPosition(steps, by('b'), 'indent')).toEqual({ parentId: 'a', afterId: null })
    expect(movedPosition(steps, by('d'), 'indent')).toEqual({ parentId: 'sub', afterId: 'c' })
    expect(movedPosition(steps, by('loose'), 'indent')).toEqual({ parentId: 'sec2', afterId: 'd' })
  })

  it('Tab：上面没有兄弟、上一个是内容块、或要把章节挂到步骤下，都不行', () => {
    const { steps, by } = doc()
    expect(movedPosition(steps, by('a'), 'indent')).toBeNull()
    const s = [step({ id: 'n', kind: 'note' }), step({ id: 'x', orderKey: 'W' })]
    expect(movedPosition(s, s[1]!, 'indent')).toBeNull()
    const t = [step({ id: 'cmd' }), step({ id: 'sec', kind: 'section', orderKey: 'W' })]
    expect(movedPosition(t, t[1]!, 'indent')).toBeNull()
    // 章节可以挂进章节
    expect(movedPosition(steps, by('sec2'), 'indent')).toEqual({ parentId: 'sec1', afterId: 'b' })
  })

  it('Shift+Tab 移出一层，排在原来的父节点后面', () => {
    const { steps, by } = doc()
    expect(movedPosition(steps, by('c'), 'outdent')).toEqual({ parentId: 'sec2', afterId: 'sub' })
    expect(movedPosition(steps, by('a'), 'outdent')).toEqual({ parentId: null, afterId: 'sec1' })
    expect(movedPosition(steps, by('sec1'), 'outdent')).toBeNull()
  })
})

describe('positionOf', () => {
  it('排在它前面的兄弟就是 afterId；第一个是 null', () => {
    const { steps, by } = doc()
    expect(positionOf(steps, by('b'))).toEqual({ parentId: 'sec1', afterId: 'a' })
    expect(positionOf(steps, by('a'))).toEqual({ parentId: 'sec1', afterId: null })
  })
})

describe('dropPosition', () => {
  it('拖到章节标题上：放进这一章最前面', () => {
    const { steps, by } = doc()
    expect(dropPosition(steps, by('sec1'), by('c'))).toEqual({ parentId: 'sec1', afterId: null })
  })

  it('拖到别的块上：排在它后面（同层）', () => {
    const { steps, by } = doc()
    expect(dropPosition(steps, by('a'), by('c'))).toEqual({ parentId: 'sec1', afterId: 'a' })
    expect(dropPosition(steps, by('b1'), by('d'))).toEqual({ parentId: 'b', afterId: 'b1' })
  })

  it('章节拖到章节上：排在它后面（同层）', () => {
    const { steps, by } = doc()
    expect(dropPosition(steps, by('sec1'), by('sec2'))).toEqual({ parentId: null, afterId: 'sec1' })
  })

  it('章节拖到步骤的子节点上：那一层放不下章节，往外找到放得下的一层', () => {
    const { steps, by } = doc()
    expect(dropPosition(steps, by('b1'), by('sub'))).toEqual({ parentId: 'sec1', afterId: 'b' })
  })

  it('拖进自己的子树里：不动', () => {
    const { steps, by } = doc()
    expect(dropPosition(steps, by('c'), by('sec2'))).toBeNull()
    expect(dropPosition(steps, by('sec2'), by('sec2'))).toBeNull()
  })
})

describe('withSubtrees', () => {
  it('选中的块连同子树，先序、不重复', () => {
    const { steps } = doc()
    expect(withSubtrees(steps, ['sec2', 'c', 'a']).map((s) => s.id)).toEqual(['a', 'sec2', 'sub', 'c', 'd'])
  })
})
