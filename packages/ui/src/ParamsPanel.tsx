import { useEffect, useState } from 'react'
import type { Param, ParamField, Step } from '@qb/core'
import { machineName, machineParam, othersWithValue, parseMachines, PARAM_NAME_RE, paramRefs, toParamName } from '@qb/core'
import { api, type LiteralSuggestionView } from './api.ts'

interface Props {
  taskId: string
  params: Param[]
  /** 章节（参数可以归到某一章下面）。 */
  sections: Step[]
  /** 全部块（算每个参数用在哪几步）。 */
  steps: Step[]
  /** 从命令里点过来的参数：展开并高亮它。 */
  focus: string | null
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
 * - 名字可以用中文（容器名、机器195）
 * - 一台机器是一个参数：主值是 IP，用户、密码、端口是字段（密码打码、只存本机）；
 *   贴一行 "IP 用户 密码" 就能加上
 * - 参数可以归到某一章下面（容器名只在"建容器"那一章用）；名字在整份文档里唯一
 * - 默认只展开"这次要确认的"（缺值 / QB 猜的），其余按归属分组折叠
 */
export function ParamsPanel({ taskId, params, sections, steps, focus, onChanged, toast }: Props) {
  const [expanded, setExpanded] = useState(false)
  // 本地权威副本：保存后立刻更新，连续改两行时第二行看到的是第一行改过的表，
  // 不会用刷新前的 props 把第一行的修改滚回去
  const [list, setList] = useState(params)
  const [suggestions, setSuggestions] = useState<LiteralSuggestionView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<'param' | 'machine' | null>(null)

  useEffect(() => setList(params), [params])
  useEffect(() => {
    if (focus !== null) setExpanded(true)
  }, [focus])

  const confirmList = list.filter((p) => p.value === '' || p.source === 'qb_guess' || (p.fields ?? []).some((f) => f.value === ''))
  const shown = expanded ? list : confirmList
  const sectionTitle = new Map(sections.map((s) => [s.lineageKey, s.title]))

  const saveAll = async (next: Param[], note?: string): Promise<boolean> => {
    setBusy(true)
    const before = list
    setList(next) // 乐观更新
    try {
      await api.updateParams(taskId, next)
      if (note !== undefined) toast(note)
      onChanged()
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' })
      setList(before) // 回滚
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveOne = async (name: string, patch: Partial<Param>): Promise<void> => {
    const next = list.map((p) => (p.name === name ? { ...p, ...patch } : p))
    const ok = await saveAll(next)
    if (!ok || patch.value === undefined) return
    const others = othersWithValue(list, name, list.find((p) => p.name === name)?.value ?? '')
    if (others.length > 0 && patch.value !== list.find((p) => p.name === name)?.value) {
      toast(`${others.join('、')} 原来也是这个值`, {
        action: {
          label: '一起改',
          run: () => void saveAll(next.map((p) => (others.includes(p.name) ? { ...p, value: patch.value! } : p))),
        },
      })
    }
  }

  /** 改名：参数表里改，命令里的 {{旧名}} 一起换。 */
  const rename = async (from: string, to: string): Promise<void> => {
    if (to === from) return
    if (!PARAM_NAME_RE.test(to)) {
      toast('参数名用大写英文、数字、下划线（如 DECODE_HOST），或带中文（如 容器名）；不能以数字开头', { tone: 'error' })
      return
    }
    if (list.some((p) => p.name === to)) {
      toast(`已经有参数 ${to} 了`, { tone: 'error' })
      return
    }
    setBusy(true)
    try {
      await api.renameParam(taskId, from, to)
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

  // 按归属分组：整份文档的在前，各章的按文档顺序
  const groups: Array<{ key: string | null; title: string; items: Param[] }> = []
  for (const p of shown) {
    const key = p.scope ?? null
    let g = groups.find((x) => x.key === key)
    if (g === undefined) {
      g = { key, title: key === null ? '' : `「${sectionTitle.get(key) ?? '（章节已删）'}」里的`, items: [] }
      groups.push(g)
    }
    g.items.push(p)
  }
  groups.sort((a, b) => (a.key === null ? -1 : b.key === null ? 1 : sections.findIndex((s) => s.lineageKey === a.key) - sections.findIndex((s) => s.lineageKey === b.key)))

  const usage = (name: string): number => steps.filter((s) => paramRefs(`${s.command ?? ''}\n${s.bodyMd ?? ''}`).includes(name)).length

  return (
    <div className="params-panel">
      <div className="params-head">
        <h3>
          参数 · {list.length === 0 ? '还没有' : confirmList.length > 0 ? `这次要确认的 ${confirmList.length} 个` : `${list.length} 个`}
        </h3>
        {list.length > confirmList.length && (
          <button className="btn ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `全部 ${list.length} 个 ▸`}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setAdding('machine')} title="贴一行 IP 用户 密码">
          ＋ 机器
        </button>
        <button className="btn ghost" onClick={() => setAdding('param')}>
          ＋ 参数
        </button>
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

      {adding === 'machine' && (
        <AddMachine
          busy={busy}
          taken={new Set(list.map((p) => p.name))}
          onCancel={() => setAdding(null)}
          onAdd={async (ps) => {
            const ok = await saveAll([...list, ...ps], `已加上 ${ps.map((p) => p.name).join('、')}：命令里写 {{${ps[0]!.name}}} 是 IP，{{${ps[0]!.name}.用户}}、{{${ps[0]!.name}.密码}} 是字段`)
            if (ok) setAdding(null)
          }}
        />
      )}
      {adding === 'param' && (
        <AddParam
          busy={busy}
          sections={sections}
          onCancel={() => setAdding(null)}
          onAdd={async (p) => {
            if (list.some((x) => x.name === p.name)) {
              toast(`已经有参数 ${p.name} 了`, { tone: 'error' })
              return
            }
            const ok = await saveAll([...list, p], `已加上 ${p.name}：命令里写 {{${p.name}}}`)
            if (ok) setAdding(null)
          }}
        />
      )}

      {groups.map((g) => (
        <div key={g.key ?? 'doc'} className="param-group">
          {g.title !== '' && <div className="param-group-title">{g.title}</div>}
          {g.items.map((p) => (
            <ParamRow
              key={p.name}
              param={p}
              busy={busy}
              focused={focus === p.name}
              uses={usage(p.name)}
              sections={sections}
              onSave={(patch) => void saveOne(p.name, patch)}
              onRename={(to) => void rename(p.name, to)}
              onRemove={() => {
                const n = usage(p.name)
                if (n > 0 && !window.confirm(`${n} 个块还用着 {{${p.name}}}，删掉后它们会提示"未声明的参数"。确定删？`)) return
                void saveAll(
                  list.filter((x) => x.name !== p.name),
                  `已删掉 ${p.name}`,
                )
              }}
            />
          ))}
        </div>
      ))}
      {shown.length === 0 && list.length > 0 && <div className="dim">没有待确认的参数。</div>}
      {list.length === 0 && adding === null && (
        <div className="dim">命令里随环境变化的取值（机器、端口、路径、卡号、容器名）可以提成参数，命令里写 {'{{名字}}'}。名字可以用中文。</div>
      )}
    </div>
  )
}

function ParamRow({
  param: p,
  busy,
  focused,
  uses,
  sections,
  onSave,
  onRename,
  onRemove,
}: {
  param: Param
  busy: boolean
  focused: boolean
  uses: number
  sections: Step[]
  onSave: (patch: Partial<Param>) => void
  onRename: (to: string) => void
  onRemove: () => void
}) {
  const [value, setValue] = useState(p.value)
  const [name, setName] = useState(p.name)
  const [more, setMore] = useState(false)
  useEffect(() => setValue(p.value), [p.value])
  useEffect(() => setName(p.name), [p.name])
  const missing = p.value === ''
  const fields = p.fields ?? []

  return (
    <div className={`param-row${p.source === 'mine' ? ' changed' : ''}${missing ? ' missing' : ''}${focused ? ' focused' : ''}`}>
      <div className="param-main">
        <input
          className="param-name"
          value={name}
          title={`命令里写 {{${p.name}}}${fields.length > 0 ? `，字段写 {{${p.name}.${fields[0]!.key}}}` : ''} · 用在 ${uses} 个块里`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const to = name.trim()
            if (to !== p.name) onRename(to)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setName(p.name)
          }}
          disabled={busy}
        />
        {p.valueLabel !== undefined && <span className="field-key">{p.valueLabel}</span>}
        <input
          className="param-value"
          type={p.secret ? 'password' : 'text'}
          value={value}
          placeholder="（缺）"
          autoFocus={focused}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value !== p.value) onSave({ value })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          disabled={busy}
        />
        <button
          className={`chip secret-toggle${p.secret ? ' on' : ''}`}
          title={p.secret ? '点击取消 secret（值会上传）' : '点击标为 secret（只存本机、打码、永不上传）'}
          onClick={() => onSave({ secret: !p.secret })}
        >
          {p.secret ? '🔒' : '🔓'}
        </button>
        <span className="param-source" title={p.description ?? ''}>
          {SOURCE_LABEL[p.source]}
          {uses === 0 ? ' · 没用到' : ''}
        </span>
        <button className="btn ghost more-btn" title="更多" onClick={() => setMore((v) => !v)}>
          ⋯
        </button>
      </div>
      {fields.map((f, i) => (
        <FieldRow
          key={f.key}
          field={f}
          busy={busy}
          onSave={(next) => onSave({ fields: fields.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => onSave({ fields: fields.filter((_, j) => j !== i) })}
        />
      ))}
      {more && (
        <div className="param-more">
          <label>
            说明
            <input className="param-value" defaultValue={p.description ?? ''} onBlur={(e) => e.target.value !== (p.description ?? '') && onSave({ description: e.target.value })} />
          </label>
          <label>
            归到
            <select value={p.scope ?? ''} onChange={(e) => onSave({ scope: e.target.value === '' ? null : e.target.value })}>
              <option value="">整份文档</option>
              {sections
                .filter((s) => s.lineageKey !== null)
                .map((s) => (
                  <option key={s.id} value={s.lineageKey!}>
                    「{s.title}」这一章
                  </option>
                ))}
            </select>
          </label>
          <button className="btn ghost" onClick={() => onSave({ fields: [...fields, { key: nextFieldKey(fields), value: '', secret: false }] })}>
            ＋ 字段
          </button>
          <button className="btn ghost danger-text" onClick={onRemove}>
            删掉这个参数
          </button>
        </div>
      )}
    </div>
  )
}

function nextFieldKey(fields: ParamField[]): string {
  for (const k of ['用户', '密码', '端口', '字段']) if (!fields.some((f) => f.key === k)) return k
  return `字段${fields.length + 1}`
}

function FieldRow({ field, busy, onSave, onRemove }: { field: ParamField; busy: boolean; onSave: (f: ParamField) => void; onRemove: () => void }) {
  const [key, setKey] = useState(field.key)
  const [value, setValue] = useState(field.value)
  useEffect(() => setValue(field.value), [field.value])
  useEffect(() => setKey(field.key), [field.key])
  return (
    <div className={`param-field${field.value === '' ? ' missing' : ''}`}>
      <input
        className="field-key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onBlur={() => key.trim() !== '' && key !== field.key && onSave({ ...field, key: key.trim() })}
        disabled={busy}
      />
      <input
        className="param-value"
        type={field.secret ? 'password' : 'text'}
        value={value}
        placeholder="（缺）"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== field.value && onSave({ ...field, value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        disabled={busy}
      />
      <button className={`chip secret-toggle${field.secret ? ' on' : ''}`} title={field.secret ? '点击取消 secret' : '标为 secret（只存本机、打码、永不上传）'} onClick={() => onSave({ ...field, secret: !field.secret })}>
        {field.secret ? '🔒' : '🔓'}
      </button>
      <button className="btn ghost" title="删掉这个字段" onClick={onRemove}>
        ✕
      </button>
    </div>
  )
}

/** 加机器：贴一行（或几行）"IP 用户 密码"，每台一个参数。 */
function AddMachine({ busy, taken, onAdd, onCancel }: { busy: boolean; taken: ReadonlySet<string>; onAdd: (ps: Param[]) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState('')
  const machines = parseMachines(text)
  const names = new Set(taken)
  const preview = machines.map((m) => {
    const p = machineParam(m, machineName(m.host, names))
    names.add(p.name)
    return p
  })
  return (
    <div className="param-add" onKeyDown={(e) => e.stopPropagation()}>
      <textarea
        className="param-value mono"
        autoFocus
        rows={2}
        placeholder={'一行一台：10.9.8.195  root  密码\n也认 root@10.0.3.17、IP：… 用户：… 密码：…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {preview.length > 0 ? (
        <div className="dim">
          {preview.map((p) => (
            <div key={p.name}>
              {p.name} = {p.value}
              {(p.fields ?? []).map((f) => ` · ${f.key} ${f.secret ? '••••' : f.value}`).join('')}
            </div>
          ))}
        </div>
      ) : (
        text.trim() !== '' && <div className="verdict unclear">没认出 IP 或主机名</div>
      )}
      <div className="cap-actions">
        <button className="btn primary" disabled={busy || preview.length === 0} onClick={() => void onAdd(preview)}>
          加上 {preview.length > 1 ? `${preview.length} 台` : ''}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

/** 手动加一个参数：名字可以用中文；可以直接归到某一章。 */
function AddParam({ busy, sections, onAdd, onCancel }: { busy: boolean; sections: Step[]; onAdd: (p: Param) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState('')
  const normalized = name.trim() === '' ? '' : PARAM_NAME_RE.test(name.trim()) ? name.trim() : toParamName(name)
  const submit = (): void => {
    if (normalized === '' || !PARAM_NAME_RE.test(normalized)) return
    void onAdd({ name: normalized, value, source: 'mine', secret: false, ...(scope !== '' ? { scope } : {}) })
  }
  return (
    <div className="param-add" onKeyDown={(e) => e.stopPropagation()}>
      <div className="param-main">
        <input className="param-name" autoFocus placeholder="名字，如 容器名 或 DECODE_HOST" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <input className="param-value" placeholder="值（可以先空着）" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <select value={scope} onChange={(e) => setScope(e.target.value)} title="只在某一章里用的参数，可以归到那一章下面">
          <option value="">整份文档</option>
          {sections
            .filter((s) => s.lineageKey !== null)
            .map((s) => (
              <option key={s.id} value={s.lineageKey!}>
                「{s.title}」
              </option>
            ))}
        </select>
      </div>
      <div className="cap-actions">
        <button className="btn primary" disabled={busy || normalized === '' || !PARAM_NAME_RE.test(normalized)} onClick={submit}>
          {normalized !== '' && normalized !== name.trim() ? `加上 ${normalized}` : '加上'}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
