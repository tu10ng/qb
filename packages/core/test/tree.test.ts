import { describe, expect, it } from 'vitest'
import type { Step } from '../src/schema.ts'
import {
  dropPosition,
  insertionAfter,
  insertionAtEnd,
  isSection,
  movedPosition,
  positionOf,
  topLevelOf,
  type Position,
} from '../src/tree.ts'

/**
 * 树上的位置计算。列表是先序的（同层按 orderKey），id 即名字。
 * 拖拽、插入、撤销都建立在这些函数上——位置算错，编辑全跟着错。
 */

let n = 0
function step(partial: Partial<Step> & { title: string }): Step {
  return {
    id: partial.id ?? `s${++n}`,
    runbookId: 'rbk',
    parentId: partial.parentId ?? null,
    orderKey: partial.orderKey ?? 'V',
    kind: partial.kind ?? 'command',
    title: partial.title,
    whyMd: null,
    whySource: null,
    command: null,
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
  }
}

function section(title: string): Step {
  return step({ title, kind: 'note', parentId: null })
}

/** 两章各两步：[sec1, a, b, sec2, c, d]。子步骤的 parentId 指向所属章节。 */
function twoSections(): { steps: Step[]; by: (t: string) => Step } {
  const sec1 = section('1 准备')
  sec1.id = 'sec1'
  const sec2 = section('2 启动')
  sec2.id = 'sec2'
  const flat = [sec1, ...flatChildren(sec1), sec2, ...flatChildren2(sec2)]
  const by = (t: string): Step => flat.find((s) => s.title === t)!
  return { steps: flat, by }
}

// 展平辅助：直接手写先序，避免工厂函数复杂化
function flatChildren(sec1: Step): Step[] {
  return [
    step({ id: 'a', title: 'a', parentId: sec1.id, orderKey: 'k1' }),
    step({ id: 'b', title: 'b', parentId: sec1.id, orderKey: 'k2' }),
  ]
}
function flatChildren2(sec2: Step): Step[] {
  return [
    step({ id: 'c', title: 'c', parentId: sec2.id, orderKey: 'k1' }),
    step({ id: 'd', title: 'd', parentId: sec2.id, orderKey: 'k2' }),
  ]
}

describe('isSection / topLevelOf', () => {
  it('顶层的 note 是章节；嵌套的 note 不是', () => {
    const { by } = twoSections()
    expect(isSection(by('1 准备'))).toBe(true)
    expect(isSection(by('a'))).toBe(false)
  })

  it('沿父链走到顶层', () => {
    const { by, steps } = twoSections()
    expect(topLevelOf(steps, by('c')).id).toBe('sec2')
    expect(topLevelOf(steps, by('1 准备')).id).toBe('sec1')
  })
})

describe('insertionAfter', () => {
  it('章节标题下面 = 这一章的第一步', () => {
    const { by } = twoSections()
    expect(insertionAfter(by('1 准备'))).toEqual({ parentId: 'sec1', afterId: null })
  })

  it('普通步骤下面 = 同层紧随其后', () => {
    const { by } = twoSections()
    expect(insertionAfter(by('a'))).toEqual({ parentId: 'sec1', afterId: 'a' })
    expect(insertionAfter(by('b'))).toEqual({ parentId: 'sec1', afterId: 'b' })
  })
})

describe('insertionAtEnd', () => {
  it('空文档放最前', () => {
    expect(insertionAtEnd([])).toEqual({ parentId: null, afterId: null })
  })

  it('最后一章有步骤时追加到章内末尾', () => {
    const { steps } = twoSections()
    expect(insertionAtEnd(steps)).toEqual({ parentId: 'sec2', afterId: 'd' })
  })

  it('最后一章没有步骤时成为第一步', () => {
    const sec = section('1 准备')
    sec.id = 'sec1'
    expect(insertionAtEnd([sec])).toEqual({ parentId: 'sec1', afterId: null })
  })
})

describe('movedPosition', () => {
  it('上移越过前一个；已在最前时不可移', () => {
    const { by } = twoSections()
    expect(movedPosition(twoSections().steps, by('b'), 'up')).toEqual({ parentId: 'sec1', afterId: null })
    expect(movedPosition(twoSections().steps, by('a'), 'up')).toBeNull()
  })

  it('下移到下一个后面；已在最后时不可移', () => {
    const { by } = twoSections()
    expect(movedPosition(twoSections().steps, by('c'), 'down')).toEqual({ parentId: 'sec2', afterId: 'd' })
    expect(movedPosition(twoSections().steps, by('d'), 'down')).toBeNull()
  })

  it('Tab 移进紧邻上面的章节末尾；上面不是章节或自己是章节时不可移', () => {
    const { by, steps } = twoSections()
    expect(movedPosition(steps, by('c'), 'indent')).toBeNull() // c 在章首，上面是章节标题（不同层）
    expect(movedPosition(steps, by('1 准备'), 'indent')).toBeNull()
  })

  it('Shift+Tab 移出章节、排在自己章节的后面', () => {
    const { by, steps } = twoSections()
    expect(movedPosition(steps, by('c'), 'outdent')).toEqual({ parentId: null, afterId: 'sec2' })
    expect(movedPosition(steps, by('1 准备'), 'outdent')).toBeNull()
  })
})

describe('positionOf', () => {
  it('排在它前面的兄弟就是 afterId；章首是 null', () => {
    const { by, steps } = twoSections()
    expect(positionOf(steps, by('b'))).toEqual({ parentId: 'sec1', afterId: 'a' })
    expect(positionOf(steps, by('a'))).toEqual({ parentId: 'sec1', afterId: null })
  })
})

describe('dropPosition', () => {
  it('普通步骤拖到章节标题上：放进这一章最前面', () => {
    const { by, steps } = twoSections()
    expect(dropPosition(steps, by('1 准备'), by('c'))).toEqual({ parentId: 'sec1', afterId: null })
  })

  it('普通步骤拖到普通步骤上：放在它后面', () => {
    const { by, steps } = twoSections()
    expect(dropPosition(steps, by('a'), by('c'))).toEqual({ parentId: 'sec1', afterId: 'a' })
  })

  it('章节拖到章节上：排在目标章节后面，仍是顶层', () => {
    const { by, steps } = twoSections()
    expect(dropPosition(steps, by('1 准备'), by('2 启动'))).toEqual({ parentId: null, afterId: 'sec1' })
  })

  it('章节拖到章内步骤上：排在那个步骤所属章节的后面，不降级成子节点', () => {
    const { by, steps } = twoSections()
    expect(dropPosition(steps, by('c'), by('2 启动'))).toEqual({ parentId: null, afterId: 'sec2' })
  })

  it('章节拖到顶层普通步骤上：排在它后面', () => {
    const loose = step({ id: 'loose', title: '散步骤', parentId: null })
    const { by } = twoSections()
    expect(dropPosition([loose], loose, by('1 准备'))).toEqual({ parentId: null, afterId: 'loose' })
  })
})
