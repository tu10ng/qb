/**
 * runbook 树上的位置计算（纯函数）。
 *
 * 步骤列表是先序的（同层按 orderKey），位置统一表示成
 * "父节点 + 排在哪个兄弟之后"（afterId=null 表示最前）。
 * 放在 core 是为了能直接单测——树算错，编辑、拖拽、撤销全跟着错。
 *
 * 嵌套规则：章节可以放在任意层、里面放任何东西；要做的步骤下面可以挂
 * 子步骤和说明，但不能挂章节；文字、代码、回显和委派行是叶子。
 */

import type { Step, StepKind } from './schema.ts'

export interface Position {
  parentId: string | null
  afterId: string | null
}

/** 文档内容（章节、文字、代码、回显）：只读、可复制，不算进度、不能运行。 */
const CONTENT_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['section', 'note', 'code', 'output'])

export function isSection(step: Pick<Step, 'kind'>): boolean {
  return step.kind === 'section'
}

export function isContent(step: Pick<Step, 'kind'>): boolean {
  return CONTENT_KINDS.has(step.kind)
}

/** 要"做"的步骤：有完成/跳过/失败，算进度。 */
export function isDoable(step: Pick<Step, 'kind'>): boolean {
  return !CONTENT_KINDS.has(step.kind)
}

/** 能不能运行：要做的步骤（委派行除外）且有命令。代码、回显只复制不运行。 */
export function isRunnable(step: Pick<Step, 'kind' | 'command'>): boolean {
  return isDoable(step) && step.kind !== 'delegate' && step.command !== null && step.command.trim() !== ''
}

/** 命令正文要不要按参数渲染：命令与代码要；回显是原样的日志，不动。 */
export function isTemplated(step: Pick<Step, 'kind'>): boolean {
  return step.kind !== 'output' && step.kind !== 'section' && step.kind !== 'note'
}

/**
 * 给模型看、让它提议修改的那张步骤清单（差异、情况变了）：去掉章节与回显。
 * 序号就是这张清单里的下标——界面把模型的序号映射回步骤时用同一个函数。
 */
export function adaptableSteps<T extends Pick<Step, 'kind'>>(steps: T[]): T[] {
  return steps.filter((s) => s.kind !== 'section' && s.kind !== 'output')
}

/** 这种块下面能不能挂东西。 */
export function canHaveChildren(kind: StepKind): boolean {
  return kind === 'section' || kind === 'command' || kind === 'check' || kind === 'wait' || kind === 'manual' || kind === 'decision'
}

/** child 能不能挂在 parent 下面（null = 顶层，什么都能放）。 */
export function canContain(parent: Pick<Step, 'kind'> | null, child: Pick<Step, 'kind'>): boolean {
  if (parent === null) return true
  if (parent.kind === 'section') return true
  return canHaveChildren(parent.kind) && child.kind !== 'section'
}

export function siblingsOf(steps: Step[], step: Pick<Step, 'parentId'>): Step[] {
  return steps.filter((s) => s.parentId === step.parentId)
}

export function childrenOf(steps: Step[], parentId: string): Step[] {
  return steps.filter((s) => s.parentId === parentId)
}

/** 沿父链走到顶层的那个节点。 */
export function topLevelOf(steps: Step[], step: Step): Step {
  let cur = step
  while (cur.parentId !== null) {
    const parent = steps.find((s) => s.id === cur.parentId)
    if (parent === undefined) break
    cur = parent
  }
  return cur
}

/** 祖先链（近的在前）。 */
export function ancestorsOf(steps: Step[], step: Pick<Step, 'parentId'>): Step[] {
  const out: Step[] = []
  let parentId = step.parentId
  while (parentId !== null) {
    const parent = steps.find((s) => s.id === parentId)
    if (parent === undefined || out.includes(parent)) break
    out.push(parent)
    parentId = parent.parentId
  }
  return out
}

/** 层级深度：顶层是 0。 */
export function depthOf(steps: Step[], step: Pick<Step, 'parentId'>): number {
  return ancestorsOf(steps, step).length
}

/** node 是不是 root 自己或 root 的子孙。 */
export function isWithin(steps: Step[], node: Step, root: Step): boolean {
  return node.id === root.id || ancestorsOf(steps, node).some((a) => a.id === root.id)
}

/** 一步所属的最近一个章节（它自己是章节时就是它自己）。 */
export function sectionOf(steps: Step[], step: Step): Step | null {
  if (isSection(step)) return step
  return ancestorsOf(steps, step).find(isSection) ?? null
}

/** 一步当前所在的位置——撤销移动、撤销删除时要回到这里。 */
export function positionOf(steps: Step[], step: Step): Position {
  const sibs = siblingsOf(steps, step)
  const idx = sibs.findIndex((s) => s.id === step.id)
  return { parentId: step.parentId, afterId: idx > 0 ? sibs[idx - 1]!.id : null }
}

/**
 * 在某一步"下面"插入的位置——就是界面上它下面那条插入线的位置。
 *
 * 章节、以及挂着子步骤的步骤：插进去当第一个子节点（插入线紧挨着它，
 * 下面就是它的第一个子节点）。折叠着的章节看不到子节点，插在它后面。
 * 其余：同层紧随其后。
 */
export function insertionAfter(step: Step, steps: Step[] = [], collapsed = false): Position {
  if (!collapsed && (isSection(step) || steps.some((s) => s.parentId === step.id))) {
    return { parentId: step.id, afterId: null }
  }
  return { parentId: step.parentId, afterId: step.id }
}

/**
 * 文档末尾追加：落在最后一个（最深的）章节的末尾——读到哪写到哪。
 */
export function insertionAtEnd(steps: Step[]): Position {
  const top = steps.filter((s) => s.parentId === null)
  let last = top[top.length - 1]
  if (last === undefined) return { parentId: null, afterId: null }
  if (!isSection(last)) return { parentId: null, afterId: last.id }
  for (;;) {
    const kids = childrenOf(steps, last.id)
    const tail = kids[kids.length - 1]
    if (tail === undefined) return { parentId: last.id, afterId: null }
    if (!isSection(tail)) return { parentId: last.id, afterId: tail.id }
    last = tail
  }
}

export type MoveDirection = 'up' | 'down' | 'indent' | 'outdent'

/**
 * Alt+↑↓ 同层移动；Tab 挂到上一个兄弟下面（它是章节就成为这一章的最后
 * 一项，是步骤就成为它的子步骤）；Shift+Tab 移出一层。不能移动时返回 null。
 */
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
      const prev = idx > 0 ? sibs[idx - 1] : undefined
      if (prev === undefined || !canContain(prev, step)) return null
      const kids = childrenOf(steps, prev.id)
      return { parentId: prev.id, afterId: kids[kids.length - 1]?.id ?? null }
    }
    case 'outdent': {
      if (step.parentId === null) return null
      const parent = steps.find((s) => s.id === step.parentId)
      const grand = parent?.parentId ?? null
      const grandStep = grand === null ? null : (steps.find((s) => s.id === grand) ?? null)
      if (!canContain(grandStep, step)) return null
      return { parentId: grand, afterId: step.parentId }
    }
  }
}

/**
 * 拖到某一步上松手的位置。
 *
 * - 拖到章节标题上：非章节的块放进这一章最前面；章节排在它后面（同层）
 * - 拖到别的块上：排在它后面（同层）
 * 目标所在的那一层放不下被拖的块（章节不能挂到步骤下面）时，往外找到放
 * 得下的那一层，排在那个祖先后面。拖进自己的子树里返回 null。
 */
export function dropPosition(steps: Step[], target: Step, dragged: Step): Position | null {
  if (isWithin(steps, target, dragged)) return null
  if (isSection(target) && !isSection(dragged)) return { parentId: target.id, afterId: null }

  let anchor: Step = target
  for (;;) {
    const parent = anchor.parentId === null ? null : (steps.find((s) => s.id === anchor.parentId) ?? null)
    if (canContain(parent, dragged)) return { parentId: anchor.parentId, afterId: anchor.id }
    if (parent === null) return { parentId: null, afterId: anchor.id }
    anchor = parent
  }
}

/**
 * 一组步骤连同子树（先序、去重）：被选中的祖先已包含子孙时不再单列。
 * "从别的任务挑步骤"复制时用。
 */
export function withSubtrees(steps: Step[], ids: string[]): Step[] {
  const chosen = new Set(ids)
  return steps.filter((s) => chosen.has(s.id) || ancestorsOf(steps, s).some((a) => chosen.has(a.id)))
}
