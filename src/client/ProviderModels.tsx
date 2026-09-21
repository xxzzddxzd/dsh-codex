/** Per-model visibility and capacity settings shared by all Provider subpages. */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { OPENAI_CODEX_PROVIDER } from '../provider-ids.ts'
import type { ManagedProvider } from '../provider-ids.ts'
import type { ModelSettingsRow } from '../model-preferences.ts'
import type { ProviderSettingsInjected } from './ProviderSettings.tsx'

const card: CSSProperties = { padding: 16, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, color: 'var(--dsw-alias-label-primary)', display: 'grid', gap: 12 }
const input: CSSProperties = { boxSizing: 'border-box', width: '100%', minWidth: 0, padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' }
const button: CSSProperties = { ...input, width: 'auto', cursor: 'pointer' }
type Draft = ModelSettingsRow & { contextText: string; outputText: string }
function drafts(rows: ModelSettingsRow[]): Draft[] {
  return rows.map(row => ({ ...row, contextText: row.contextWindow?.toString() ?? '', outputText: row.maxTokens?.toString() ?? '' }))
}

export function ProviderModels({ provider, t }: { provider: ManagedProvider; t: ProviderSettingsInjected['t'] }) {
  const [rows, setRows] = useState<Draft[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const url = `/plugins/dsh-openai-codex/providers/${provider}/models`
  async function request(body?: unknown): Promise<ModelSettingsRow[]> {
    const response = await fetch(url, { credentials: 'same-origin',
      ...body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    })
    const data = await response.json() as { models: ModelSettingsRow[]; error?: string }
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    return data.models
  }
  useEffect(() => {
    let active = true
    setRows(undefined)
    setError('')
    void request().then(value => { if (active) setRows(drafts(value)) }, cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [provider])
  function edit(id: string, patch: Partial<Draft>) {
    setRows(current => current?.map(row => row.id === id ? { ...row, ...patch } : row))
    setSaved(false)
  }
  async function save() {
    setBusy(true); setError(''); setSaved(false)
    try {
      const models = (rows ?? []).map(row => {
        const values: { contextWindow?: number; maxTokens?: number } = {}
        for (const [key, text] of [['contextWindow', row.contextText], ['maxTokens', row.outputText]] as const) {
          if (!text.trim()) continue
          if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) throw new Error(t('modelNumberInvalid'))
          values[key] = Number(text)
        }
        return { id: row.id, visible: row.visible !== false, ...values }
      })
      setRows(drafts(await request({ models })))
      setSaved(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section style={card}>
    <h3 style={{ margin: 0 }}>{t('modelSettings')}</h3>
    <p style={{ margin: 0, fontSize: 13 }}>{t('modelSettingsHint')}</p>
    {provider === OPENAI_CODEX_PROVIDER ? <p style={{ margin: 0, fontSize: 13 }}>{t('codexOutputHint')}</p> : null}
    {rows?.length === 0 ? <p>{t('modelsEmpty')}</p> : null}
    {rows?.map(row => <details key={row.id} style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 }}>
      <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>{row.name} · {row.visible === false ? t('modelHidden') : t('modelShown')}</summary>
      <div style={{ display: 'grid', gap: 10, paddingTop: 12 }}>
        <label><input type="checkbox" disabled={busy} checked={row.visible !== false} onChange={event => edit(row.id, { visible: event.target.checked })} /> {t('modelVisible')}</label>
        <label>{t('modelContext')}<input style={input} type="text" inputMode="numeric" disabled={busy} value={row.contextText} placeholder={row.defaultContextWindow?.toString() ?? t('modelUnknownDefault')} onChange={event => edit(row.id, { contextText: event.target.value })} /></label>
        <label>{t('modelOutput')}<input style={input} type="text" inputMode="numeric" disabled={busy} value={row.outputText} placeholder={row.defaultMaxTokens?.toString() ?? t('modelUnknownDefault')} onChange={event => edit(row.id, { outputText: event.target.value })} /></label>
        <button type="button" style={button} disabled={busy} onClick={() => edit(row.id, { visible: true, contextText: '', outputText: '' })}>{t('modelReset')}</button>
      </div>
    </details>)}
    {error ? <p role="alert" style={{ overflowWrap: 'anywhere', color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p> : null}
    {saved ? <p role="status">{t('modelsSaved')}</p> : null}
    <button style={button} type="button" disabled={busy || rows === undefined} onClick={() => { void save() }}>{busy ? t('working') : t('modelsSave')}</button>
  </section>
}
