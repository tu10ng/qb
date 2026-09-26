import type { Step } from '@qb/core'

/**
 * runbook 树上的位置计算。步骤列表是先序的（同层按 orderKey），
 * 位置统一表示成"父节点 + 排在哪个兄弟之后"（afterId=null 表示最前）。
 */

export interface Position {
  parentId: string | null
  afterId: string | null
}

export function siblingsOf(steps: Step[], step: Pick<Step, 'parentId'>): Step[] {
  return steps.filter((s) => s.parentId === step.parentId)
}

function childrenOf(steps: Step[], parentId: string): Step[] {
  return steps.filter((s) => s.parentId === parentId)
}

/** 顶层的 note 就是章节。 */
export function isSection(step: Step): boolean {
  return step.kind === 'note' && step.parentId === null
}

/** 一步当前所在的位置——撤销移动、撤销删除时要回到这里。 */
export function positionOf(steps: Step[], step: Step): Position {
  const sibs = siblingsOf(steps, step)
  const idx = sibs.findIndex((s) => s.id === step.id)
  return { parentId: step.parentId, afterId: idx > 0 ? sibs[idx - 1]!.id : null }
}

/**
 * 在某一步"下面"插入的位置。
 *
 * 章节标题下面插入 = 成为这一章的第一步；普通步骤下面插入 = 同层紧随其后。
 */
export function insertionAfter(step: Step): Position {
  if (isSection(step)) return { parentId: step.id, afterId: null }
  return { parentId: step.parentId, afterId: step.id }
}

/** 文档末尾追加：有章节就追加到最后一章的末尾。 */
export function insertionAtEnd(steps: Step[]): Position {
  const top = steps.filter((s) => s.parentId === null)
  const last = top[top.length - 1]
  if (last === undefined) return { parentId: null, afterId: null }
  if (isSection(last)) {
    const kids = childrenOf(steps, last.id)
    return { parentId: last.id, afterId: kids[kids.length - 1]?.id ?? null }
  }
  return { parentId: null, afterId: last.id }
}

export type MoveDirection = 'up' | 'down' | 'indent' | 'outdent'

/** Alt+↑↓ 同层移动；Tab 移进上一章；Shift+Tab 移出章节。不能移动时返回 null。 */
export function movedPosition(steps: Step[], step: Step, dir: MoveDirection): Position | null {
  const sibs = siblingsOf(steps, step)
  const idx = sibs.findIndex((s) => s.id === step.id)

  switch (dir) {
    case 'up':
      if (idx <= 0) return null
      return { parentId: step.parentId, afterId: idx >= 2 ? sibs[idx - 2]!.id : null }
    case 'down':
      if (idx < 0 || idx >= sibs.length - 1) return null
      return { parentId: step.parentId, afterId: sibs[idx + 1]!.id }
    case 'indent': {
      // 只能移进紧挨在上面的那一章
      const prev = idx > 0 ? sibs[idx - 1] : undefined
      if (prev === undefined || !isSection(prev) || isSection(step)) return null
      const kids = childrenOf(steps, prev.id)
      return { parentId: prev.id, afterId: kids[kids.length - 1]?.id ?? null }
    }
    case 'outdent':
      if (step.parentId === null) return null
      return { parentId: steps.find((s) => s.id === step.parentId)?.parentId ?? null, afterId: step.parentId }
  }
}

/** 拖到某一步上松手：拖到章节标题上 = 放进这一章最前面；否则放在它后面。 */
export function dropPosition(target: Step, dragged: Step): Position {
  if (isSection(target) && !isSection(dragged)) return { parentId: target.id, afterId: null }
  return { parentId: target.parentId, afterId: target.id }
}
