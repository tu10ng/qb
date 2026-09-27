import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type Job,
  type LlmSettingsView,
  type Preset,
  type ProfileInput,
  type PublicProfile,
  type Purpose,
} from './api.ts'

const PURPOSES: Array<{ id: Purpose; label: string; hint: string }> = [
  { id: 'structure', label: '整理 / 起草', hint: '要快：步骤边写边出现' },
  { id: 'diagnose', label: '诊断', hint: '可以慢一点、想深一点' },
  { id: 'vision', label: '看截图', hint: '要能看图' },
]

interface Props {
  /** 测试连接的进度来自 WS 的 job.update。 */
  jobs: Record<string, Job>
}

/**
 * 设置 · 模型。
 *
 * 预设里是实测过的正确组合；填好地址、key、模型，保存后自动测一遍
 * 连通、结构化、流式和看图。key 只存在本机，这里永远只显示打码后的样子。
 */
export function Settings({ jobs }: Props) {
  const [view, setView] = useState<LlmSettingsView | null>(null)
  const [editing, setEditing] = useState<PublicProfile | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'llm' | 'team'>('llm')

  const refresh = useCallback(async () => {
    try {
      setView(await api.llmSettings())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 测试跑完就刷新，拿到新的能力档案
  const testsDone = Object.values(jobs)
    .filter((j) => j.kind === 'llm-test' && j.status !== 'running')
    .map((j) => j.id)
    .join(',')
  useEffect(() => {
    if (testsDone !== '') void refresh()
  }, [testsDone, refresh])

  if (view === null) {
    return <div className="settings">{error ?? '读取设置…'}</div>
  }

  const test = (id: string): void => {
    setError(null)
    api.testProfile(id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="settings">
      <h1>设置</h1>
      <div className="chip-row" style={{ marginBottom: 14 }}>
        <button className={`chip${tab === 'llm' ? ' on' : ''}`} onClick={() => setTab('llm')}>模型</button>
        <button className={`chip${tab === 'team' ? ' on' : ''}`} onClick={() => setTab('team')}>团队</button>
      </div>
      {tab === 'team' ? <TeamSection /> : (
      <>
      <p className="settings-lead">
        key 只存在这台电脑上，不同步、不写日志。<code>.env.local</code> 里的配置会作为一个只读档案出现在这里。
      </p>

      <section>
        <h2>按用途选模型</h2>
        {PURPOSES.map((p) => {
          const status = view.status[p.id]
          return (
            <div className="purpose-row" key={p.id}>
              <span className="purpose-label">{p.label}</span>
              <select
                value={view.purposes[p.id] ?? ''}
                onChange={(e) => {
                  api
                    .setPurposes({ [p.id]: e.target.value === '' ? null : e.target.value })
                    .then(setView)
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                }}
              >
                <option value="">自动（{status.profileName ?? '无'}）</option>
                {view.profiles.map((prof) => (
                  <option key={prof.id} value={prof.id}>
                    {prof.name}
                  </option>
                ))}
              </select>
              <span className={`purpose-status ${status.ok ? 'ok' : 'bad'}`}>{status.ok ? p.hint : status.reason}</span>
            </div>
          )
        })}
      </section>

      <section>
        <h2>档案</h2>
        {view.profiles.length === 0 && <p className="dim">还没有档案。点下面的"新增"，选一个预设就行。</p>}
        {view.profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            job={jobs[p.id]?.kind === 'llm-test' ? jobs[p.id] : undefined}
            onTest={() => test(p.id)}
            onEdit={() => setEditing(p)}
            onDelete={() => {
              if (!window.confirm(`删除档案「${p.name}」？`)) return
              api
                .deleteProfile(p.id)
                .then(setView)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }}
          />
        ))}
        {editing === null && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            ＋ 新增档案
          </button>
        )}
      </section>

      {editing !== null && (
        <ProfileForm
          presets={view.presets}
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(next, savedId) => {
            setView(next)
            setEditing(null)
            // 保存后立刻测一遍：用户最想知道的就是"能不能用"
            test(savedId)
          }}
        />
      )}

      {error !== null && <div className="verdict fail">{error}</div>}
      </>
      )}
    </div>
  )
}

/** 设置 · 团队：同步到团队服务（进度实时给发起人；告警推 IM）。 */
function TeamSection() {
  const [cfg, setCfg] = useState<{ url: string; hasToken: boolean; enabled: boolean } | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .teamSettings()
      .then((c) => {
        setCfg(c)
        setUrl(c.url)
        setEnabled(c.enabled)
      })
      .catch(() => setCfg(null))
  }, [])

  const test = (): void => {
    setBusy(true)
    setTestResult(null)
    api
      .testTeamSettings({ url: url !== '' ? url : undefined, ...(token !== '' ? { token } : {}) })
      .then(setTestResult)
      .catch((e: unknown) => setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false))
  }

  const save = (): void => {
    setBusy(true)
    api
      .saveTeamSettings({ url, ...(token !== '' ? { token } : {}), enabled })
      .then((c) => {
        setCfg(c)
        setUrl(c.url)
        setEnabled(c.enabled)
        setToken('')
        setTestResult({ ok: true, detail: '已保存' })
      })
      .catch((e: unknown) => setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false))
  }

  if (cfg === null) return <p className="dim">读取设置…</p>

  return (
    <section>
      <p className="settings-lead">
        团队服务（<code>node packages/team/src/index.ts</code>）让发起人实时看到进度、收到告警（推 IM）、回答你的求助。
        没配置时一切照旧，只是"问发起人"退回复制到 IM。
      </p>
      <label>
        团队服务地址
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.0.1.8:3777" />
      </label>
      <label>
        个人令牌
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={cfg.hasToken ? `已配置（留空不改）` : '在团队服务注册后拿到'}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用同步（每 3 秒一拍，离线自动排队）
      </label>
      <div className="row" style={{ display: 'flex', gap: 6 }}>
        <button className="btn primary" disabled={busy} onClick={save}>
          保存
        </button>
        <button className="btn" disabled={busy} onClick={test}>
          测试连接
        </button>
      </div>
      {testResult !== null && (
        <p className={testResult.ok ? 'verdict pass' : 'verdict fail'} style={{ marginTop: 8 }}>
          {testResult.detail}
        </p>
      )}
      {cfg.enabled && <p className="paste-hint" style={{ marginTop: 8 }}>同步中：进度、告警、求助都会推给团队服务（输出与截图不上传）。</p>}
    </section>
  )
}

function ProfileCard({
  profile,
  job,
  onTest,
  onEdit,
  onDelete,
}: {
  profile: PublicProfile
  job: Job | undefined
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const caps = profile.capabilities
  const testing = job?.status === 'running'
  return (
    <div className="profile-card">
      <div className="profile-head">
        <strong>{profile.name}</strong>
        <span className="dim">
          {profile.model} · {profile.baseUrl}
          {profile.keyHint !== '' ? ` · key ${profile.keyHint}` : ' · 没有 key'}
          {profile.options.thinking ? ' · 开思考' : ' · 关思考'}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={testing} onClick={onTest}>
          {testing ? '测试中' : '测试连接'}
        </button>
        {profile.source === 'local' ? (
          <>
            <button className="btn ghost" onClick={onEdit}>
              编辑
            </button>
            <button className="btn ghost" onClick={onDelete}>
              删除
            </button>
          </>
        ) : (
          <span className="dim" title="改 .env.local 后重启生效">
            来自 .env.local，只读
          </span>
        )}
      </div>

      {testing && <div className="paste-hint">{job?.progress ?? '开始测试…'}</div>}
      {job?.status === 'failed' && <div className="verdict fail">{job.error}</div>}

      {caps !== null && !testing && (
        <div className="caps">
          <Cap label="连通" ok={caps.connect.ok} detail={caps.connect.ok ? ms(caps.connect.ms) : caps.connect.detail} />
          <Cap
            label="结构化"
            ok={caps.structured.ok}
            detail={
              caps.structured.ok
                ? `首步 ${ms(caps.structured.firstPartialMs)} · 共 ${ms(caps.structured.ms)}${caps.structured.jsonMode === 'json_object' ? ' · json_object' : ''}`
                : caps.structured.detail
            }
          />
          <Cap label="看图" ok={caps.vision.ok} detail={caps.vision.ok ? ms(caps.vision.ms) : caps.vision.detail} />
          <span className="dim">测于 {new Date(caps.testedAt).toLocaleString('zh-CN')}</span>
        </div>
      )}
      {caps === null && !testing && <div className="paste-hint">还没测过</div>}
    </div>
  )
}

function Cap({ label, ok, detail }: { label: string; ok: boolean; detail: string | undefined }) {
  return (
    <span className={`cap ${ok ? 'ok' : 'bad'}`} title={detail}>
      {ok ? '✓' : '✗'} {label}
      {detail !== undefined && <span className="cap-detail"> {detail}</span>}
    </span>
  )
}

function ProfileForm({
  presets,
  initial,
  onCancel,
  onSaved,
}: {
  presets: Preset[]
  initial: PublicProfile | null
  onCancel: () => void
  onSaved: (view: LlmSettingsView, id: string) => void
}) {
  const [presetId, setPresetId] = useState(initial?.preset ?? presets[0]?.id ?? 'deepseek')
  const preset = presets.find((p) => p.id === presetId) ?? presets[0]!
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? preset.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(initial?.model ?? preset.model)
  const [thinking, setThinking] = useState(initial?.options.thinking ?? preset.options.thinking ?? false)
  const [maxTokens, setMaxTokens] = useState(String(initial?.options.maxOutputTokens ?? preset.options.maxOutputTokens ?? 32000))
  const [extraBody, setExtraBody] = useState(
    JSON.stringify(initial?.options.extraBody ?? preset.options.extraBody ?? {}) === '{}'
      ? ''
      : JSON.stringify(initial?.options.extraBody ?? preset.options.extraBody),
  )
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choosePreset = (id: string): void => {
    const p = presets.find((x) => x.id === id)
    if (p === undefined) return
    setPresetId(id)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setThinking(p.options.thinking ?? false)
    setMaxTokens(String(p.options.maxOutputTokens ?? 32000))
    setExtraBody(p.options.extraBody !== undefined ? JSON.stringify(p.options.extraBody) : '')
    setModels([])
  }

  const fetchModels = (): void => {
    setError(null)
    api
      .listModels({
        ...(initial !== null ? { profileId: initial.id } : {}),
        wire: preset.wire,
        baseUrl,
        ...(apiKey !== '' ? { apiKey } : {}),
      })
      .then((list) => {
        setModels(list)
        if (list.length === 0) setError('这个端点没有返回模型列表，手填模型名即可。')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const save = (): void => {
    setError(null)
    let extra: Record<string, unknown> | undefined
    if (extraBody.trim() !== '') {
      try {
        extra = JSON.parse(extraBody) as Record<string, unknown>
      } catch {
        setError('额外请求参数不是合法的 JSON')
        return
      }
    }
    const input: ProfileInput = {
      ...(initial !== null ? { id: initial.id } : {}),
      name,
      preset: presetId,
      wire: preset.wire,
      baseUrl,
      model,
      ...(apiKey !== '' ? { apiKey } : {}),
      options: {
        thinking,
        maxOutputTokens: Number(maxTokens) || 32000,
        ...(extra !== undefined ? { extraBody: extra } : {}),
      },
    }
    setBusy(true)
    api
      .saveProfile(input)
      .then((r) => onSaved(r, r.profile.id))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section className="profile-form">
      <h2>{initial === null ? '新增档案' : `编辑「${initial.name}」`}</h2>

      <label>
        预设
        <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {preset.note !== '' && <p className="dim">{preset.note}</p>}

      <label>
        地址
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
      </label>
      <label>
        Key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial !== null && initial.keyHint !== '' ? `留空表示不改（当前 ${initial.keyHint}）` : '粘贴 API key'}
        />
      </label>
      <label>
        模型
        <span className="row">
          <input list="qb-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型名" />
          <button className="btn" onClick={fetchModels}>
            拉取列表
          </button>
        </span>
        <datalist id="qb-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label className="check">
        <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
        结构化调用时让模型思考（慢 5–10 倍；DeepSeek 的 Anthropic 端点开着会报错）
      </label>
      <label>
        输出上限（token）
        <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
      </label>
      {preset.wire === 'openai-compatible' && (
        <label>
          额外请求参数（JSON，可选）
          <input
            className="mono"
            value={extraBody}
            onChange={(e) => setExtraBody(e.target.value)}
            placeholder='{"chat_template_kwargs":{"enable_thinking":false}}'
          />
        </label>
      )}
      <label>
        名字（可选）
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${preset.label} · ${model}`} />
      </label>

      <div className="row">
        <button className="btn primary" disabled={busy || baseUrl === '' || model === ''} onClick={save}>
          保存并测试
        </button>
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
      {error !== null && <div className="verdict fail">{error}</div>}
    </section>
  )
}

function ms(v: number | undefined): string {
  if (v === undefined) return '-'
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`
}
