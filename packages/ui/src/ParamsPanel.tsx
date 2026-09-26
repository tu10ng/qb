import { useEffect, useState } from 'react'
import type { Param } from '@qb/core'
import { othersWithValue } from '@qb/core'
import { api, type LiteralSuggestionView } from './api.ts'

interface Props {
  taskId: string
  params: Param[]
  /** 参数改动会改命令渲染，保存后上层刷新详情。 */
  onChanged: () => void
  toast: (text: string, opts?: { tone?: 'error'; action?: { label: string; run: () => void } }) => void
}

const SOURCE_LABEL: Record<Param['source'], string> = {
  origin: '原文',
  base: '底稿',
  mine: '这次改过',
  qb_guess: 'QB 猜的·待确认',
  env: '环境',
}

/**
 * 参数面板（方案 §4）。
 *
 * 默认只展开"这次要确认的"（缺值 / QB 猜的），其余折叠成计数；
 * 改值就地保存，同值参数提示一起改；重复出现的字面值可一键参数化。
 */
export function ParamsPanel({ taskId, params, onChanged, toast }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [suggestions, setSuggestions] = useState<LiteralSuggestionView[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDrafts({})
  }, [params])

  if (params.length === 0) return null

  const confirmList = params.filter((p) => p.value === '' || p.source === 'qb_guess')
  const highlight = new Set(params.filter((p) => p.source === 'mine').map((p) => p.name))
  const shown = expanded ? params : confirmList

  const save = async (name: string, value: string): Promise<void> => {
    setBusy(true)
    try {
      await api.updateParams(taskId, params.map((p) => (p.name === name ? { ...p, value } : p)))
      const others = othersWithValue(params, name, value)
      if (others.length > 0) {
        toast(`${others.join('、')} 原来也是这个值`, {
          action: {
            label: '一起改',
            run: () => {
              void api
                .updateParams(taskId, params.map((p) => (others.includes(p.name) || p.name === name ? { ...p, value } : p)))
                .then(onChanged)
            },
          },
        })
      }
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const fetchSuggestions = (): void => {
    setBusy(true)
    api
      .suggestParams(taskId)
      .then(setSuggestions)
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' }))
      .finally(() => setBusy(false))
  }

  const applySuggestion = async (items: Array<{ value: string; name: string }>): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.applySuggestions(taskId, items)
      toast(`已把 ${items.map((i) => i.value).join('、')} 参数化，改到 ${r.touchedSteps} 步`)
      setSuggestions((cur) => (cur === null ? null : cur.filter((s) => !items.some((i) => i.value === s.value))))
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="params-panel">
      <div className="params-head">
        <h3>
          参数 · {confirmList.length > 0 ? `这次要确认的 ${confirmList.length} 个` : '都在'}
          {highlight.size > 0 ? ` · 与底稿不同的 ${highlight.size} 个已高亮` : ''}
        </h3>
        {params.length > confirmList.length && (
          <button className="btn ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `全部 ${params.length} 个 ▸`}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" disabled={busy} onClick={fetchSuggestions} title="扫描命令里重复出现的 IP/端口/路径，提议提成参数">
          ⚡ 提取建议
        </button>
      </div>

      {suggestions !== null && (
        <div className="param-suggestions">
          {suggestions.length === 0 && <span className="dim">没有发现值得参数化的重复字面值。</span>}
          {suggestions.map((s) => (
            <div key={s.value} className="param-suggestion">
              <code>{s.value}</code>
              <span className="dim">
                提成 {s.suggestedName}（出现 {s.count} 次）
              </span>
              <button className="btn ghost" disabled={busy} onClick={() => void applySuggestion([{ value: s.value, name: s.suggestedName }])}>
                参数化
              </button>
            </div>
          ))}
          {suggestions.length > 1 && (
            <button className="btn ghost" disabled={busy} onClick={() => void applySuggestion(suggestions.map((s) => ({ value: s.value, name: s.suggestedName })))}>
              全部参数化
            </button>
          )}
        </div>
      )}

      {shown.map((p) => {
        const draft = drafts[p.name] ?? p.value
        const missing = p.value === ''
        return (
          <div key={p.name} className={`param-row${highlight.has(p.name) ? ' changed' : ''}${missing ? ' missing' : ''}`}>
            <code className="param-name">{p.name}</code>
            <input
              className="param-value"
              type={p.secret ? 'password' : 'text'}
              value={draft}
              placeholder="（缺）"
              onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
              onBlur={() => {
                if (draft !== p.value) void save(p.name, draft)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              disabled={busy}
            />
            <span className="param-source" title={p.description ?? ''}>
              {SOURCE_LABEL[p.source]}
            </span>
          </div>
        )
      })}
      {shown.length === 0 && <div className="dim">没有待确认的参数。</div>}
    </div>
  )
}
