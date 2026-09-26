import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  value: string
  /** 失焦或回车时调用；只在内容真的变了时调用。 */
  onSave: (next: string) => void | Promise<void>
  multiline?: boolean
  mono?: boolean
  placeholder?: string
  /** 挂载时直接进入编辑（刚插入的新步骤）。 */
  autoEdit?: boolean
  /** 空值时是否在非编辑态显示占位（当前步才显示，免得满屏灰字）。 */
  showPlaceholder?: boolean
  /**
   * 粘贴拦截：返回 true 表示已处理（比如多行命令问"拆成 N 步？"）。
   * 只在编辑前是空值时调用。
   */
  onPasteIntoEmpty?: (text: string) => boolean
  display?: (value: string) => ReactNode
  className?: string
}

/**
 * 点即编辑，失焦保存，Esc 取消——没有"编辑模式"（IMPLEMENTATION §7）。
 *
 * 拖选文字后松开鼠标也会触发 click；这时用户是想复制，不进入编辑。
 */
export function Editable({
  value,
  onSave,
  multiline = false,
  mono = false,
  placeholder = '',
  autoEdit = false,
  showPlaceholder = true,
  onPasteIntoEmpty,
  display,
  className = '',
}: Props) {
  const [editing, setEditing] = useState(autoEdit)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const cancelled = useRef(false)

  // 不在编辑时跟随外部变化（别的标签页改了、撤销了）
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (el === null) return
    el.focus()
    if (autoEdit) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
    fit(el)
  }, [editing, autoEdit])

  const open = (e: React.MouseEvent): void => {
    const sel = window.getSelection()
    if (sel !== null && sel.toString() !== '' && e.currentTarget.contains(sel.anchorNode)) return
    e.stopPropagation()
    cancelled.current = false
    setDraft(value)
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      setDraft(value)
      return
    }
    const next = multiline ? draft.replace(/\s+$/, '') : draft.trim()
    if (next !== value) void onSave(next)
  }

  if (!editing) {
    const empty = value.trim() === ''
    return (
      <span
        className={`editable${empty ? ' empty' : ''}${mono ? ' mono' : ''} ${className}`}
        onClick={open}
        title="点击编辑"
      >
        {empty ? (showPlaceholder ? placeholder : '') : display !== undefined ? display(value) : value}
      </span>
    )
  }

  const common = {
    ref,
    value: draft,
    className: `inline-edit editing${mono ? ' mono' : ''} ${className}`,
    placeholder,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => {
      setDraft(e.target.value)
      if (multiline) fit(e.target)
    },
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        cancelled.current = true
        ref.current?.blur()
      } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        ref.current?.blur()
      }
    },
    onPaste: (e: React.ClipboardEvent) => {
      if (onPasteIntoEmpty === undefined || draft.trim() !== '') return
      const text = e.clipboardData.getData('text/plain')
      if (onPasteIntoEmpty(text)) {
        e.preventDefault()
        cancelled.current = true
        ref.current?.blur()
      }
    },
  }

  return multiline ? <textarea rows={1} {...common} /> : <input {...common} />
}

/** 文本框随内容长高，不出现内部滚动条。 */
function fit(el: HTMLTextAreaElement | HTMLInputElement): void {
  if (!(el instanceof HTMLTextAreaElement)) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}
