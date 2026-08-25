/** Device-local VLESS node management inside the dsh Settings shell. */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { VlessSettingsKey } from './vless-locales.ts'

/** Same-origin Host route shared by the VLESS page and provider exit pickers. */
export const VLESS_SETTINGS_PATH = '/plugins/dsh-openai-codex/proxy'

/** Network exits currently offered to managed providers. */
export type CodexEgress = 'direct' | 'vless'

/** Secret-free device-local VLESS state returned by the Host. */
export interface VlessStatus {
  enabled: boolean
  egress?: CodexEgress
  configured: boolean
  running: boolean
  reachable: boolean
  pid?: number
  latencyMs?: number
  node?: string
  message?: string
}

/** Dependencies injected by the browser plugin entry. */
export interface VlessSettingsInjected {
  /** Localized page copy. */
  t: (key: VlessSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot renderer. */
export type VlessSettingsProps = Partial<VlessSettingsInjected>

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusRowStyle: CSSProperties = { ...rowStyle, flexWrap: 'nowrap' }
const statusTextStyle: CSSProperties = { ...bodyStyle, minWidth: 0, flex: '1 1 auto' }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-button-primary-fill)', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
const inputStyle: CSSProperties = { boxSizing: 'border-box', flex: '1 1 280px', minHeight: 34, padding: '6px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14 }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }

/** Request the secret-free VLESS settings surface. */
export async function vlessRequest(method = 'GET', body?: unknown): Promise<VlessStatus> {
  const response = await fetch(VLESS_SETTINGS_PATH, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as VlessStatus
}

/** Configure and test the reusable device-local VLESS exit. */
export function VlessSettings({ t }: VlessSettingsProps) {
  if (t === undefined) throw new Error('VLESS settings requires its translation function')
  const [status, setStatus] = useState<VlessStatus | undefined>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [speedBusy, setSpeedBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void vlessRequest().then(
      value => { setStatus(value); setError(undefined) },
      () => { setError(t('settingsFailed')) },
    )
  }, [t])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      setStatus(await vlessRequest('POST', { vlessUrl: draft }))
      setDraft('')
      setSaved(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settingsFailed'))
    } finally {
      setBusy(false)
    }
  }

  const speedTest = async (): Promise<void> => {
    setSpeedBusy(true)
    setError(undefined)
    try {
      setStatus(await vlessRequest('POST', { speedTest: true }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('speedTestFailed'))
    } finally {
      setSpeedBusy(false)
    }
  }

  return (
    <section style={pageStyle} aria-labelledby="vless-settings-title">
      <div>
        <h2 id="vless-settings-title" style={titleStyle}>{t('title')}</h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={sectionTitleStyle}>{t('node')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('nodeHint')}</p>
        </div>
        {status === undefined ? null : (
          <div style={statusRowStyle}>
            <p style={statusTextStyle}>
              {status.configured
                ? t('configured', { node: status.node ?? t('unnamedNode') })
                : t('notConfigured')}
              {status.pid === undefined ? '' : ` · ${t('pid', { pid: status.pid })}`}
              {status.configured ? ` · ${status.reachable ? t('ready') : t('unavailable')}` : ''}
              {status.latencyMs === undefined ? '' : ` · ${t('latency', { milliseconds: status.latencyMs })}`}
            </p>
            <button
              type="button"
              style={{ ...buttonStyle, flex: '0 0 auto' }}
              disabled={!status.configured || busy || speedBusy}
              onClick={() => { void speedTest() }}
            >
              {speedBusy ? t('speedTesting') : t('speedTest')}
            </button>
          </div>
        )}
        <div style={rowStyle}>
          <input
            type="password"
            value={draft}
            disabled={busy || speedBusy}
            autoComplete="off"
            placeholder={t('linkPlaceholder')}
            aria-label={t('linkPlaceholder')}
            spellCheck={false}
            onChange={event => { setDraft(event.target.value); setSaved(false) }}
            style={inputStyle}
          />
          <button type="button" style={primaryButtonStyle} disabled={busy || speedBusy || draft.trim() === ''} onClick={() => { void save() }}>
            {busy ? t('working') : t('save')}
          </button>
        </div>
        {error === undefined ? null : <p style={errorStyle}>{error}</p>}
        {saved ? <p style={bodyStyle}>{t('saved')}</p> : null}
      </div>
    </section>
  )
}
