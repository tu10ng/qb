import { useCallback, useRef, useState } from 'react'

/**
 * 撤销 / 重做。
 *
 * 每次编辑推一条记录：怎么撤、怎么重做都是一次接口调用。记录里不存
 * rev——执行时再取最新的，否则连续撤销两次第二次必然冲突。
 */
export interface HistoryEntry {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const LIMIT = 100

export function useHistory() {
  const past = useRef<HistoryEntry[]>([])
  const future = useRef<HistoryEntry[]>([])
  // 只为让按钮状态刷新
  const [, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)

  const push = useCallback((entry: HistoryEntry) => {
    past.current.push(entry)
    if (past.current.length > LIMIT) past.current.shift()
    future.current = []
    bump()
  }, [])

  const undo = useCallback(async (): Promise<string | null> => {
    const entry = past.current.pop()
    if (entry === undefined) return null
    try {
      await entry.undo()
      future.current.push(entry)
      return entry.label
    } finally {
      bump()
    }
  }, [])

  const redo = useCallback(async (): Promise<string | null> => {
    const entry = future.current.pop()
    if (entry === undefined) return null
    try {
      await entry.redo()
      past.current.push(entry)
      return entry.label
    } finally {
      bump()
    }
  }, [])

  return {
    push,
    undo,
    redo,
    get canUndo() {
      return past.current.length > 0
    },
    get canRedo() {
      return future.current.length > 0
    },
  }
}
