/** Reusable per-provider network-exit selector. */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ManagedProvider } from '../provider-ids.ts'
import type { ProviderSettingsKey } from './provider-locales.ts'

export type ProviderEgress = 'direct' | 'vless'

export interface ProviderEgressStatus {
  enabled: boolean
  egress: ProviderEgress
  configured: boolean
  running: boolean
  reachable: boolean
  node?: string
  message?: string
}

export type ProviderSettingsT = (key: ProviderSettingsKey, params?: Record<string, unknown>) => string

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const labelStyle: CSSProperties = { fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const selectStyle: CSSProperties = { boxSizing: 'border-box', minWidth: 220, minHeight: 36, padding: '6px 34px 6px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14 }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }

function pathFor(provider: ManagedProvider): string {
  return `/plugins/dsh-openai-codex/providers/${encodeURIComponent(provider)}/egress`
}

/** Read or update one provider's secret-free exit state. */
export async function providerEgressRequest(
  provider: ManagedProvider,
  method = 'GET',
  body?: unknown,
): Promise<ProviderEgressStatus> {
  const response = await fetch(pathFor(provider), {
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
  return value as ProviderEgressStatus
}

/** Render the shared VLESS choice inside one provider subpage. */
export function ProviderEgressSettings({ provider, t }: { provider: ManagedProvider; t: ProviderSettingsT }) {
  const [status, setStatus] = useState<ProviderEgressStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void providerEgressRequest(provider).then(
      value => { setStatus(value); setError(undefined) },
      () => { setError(t('egressFailed')) },
    )
  }, [provider, t])

  const update = async (egress: ProviderEgress): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await providerEgressRequest(provider, 'POST', { egress }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('egressFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={cardStyle}>
      <div>
        <h3 style={titleStyle}>{t('networkEgress')}</h3>
        <p style={{ ...bodyStyle, marginTop: 5 }}>{t('networkEgressHint')}</p>
      </div>
      <div style={rowStyle}>
        <label htmlFor={`${provider}-egress`} style={labelStyle}>{t('networkEgressLabel')}</label>
        <select
          id={`${provider}-egress`}
          value={status?.egress ?? 'direct'}
          disabled={status === undefined || busy}
          style={selectStyle}
          onChange={event => { void update(event.target.value as ProviderEgress) }}
        >
          <option value="direct">{t('egressDirect')}</option>
          <option value="vless" disabled={status?.configured !== true}>
            {status?.configured === true
              ? t('egressVlessNode', { node: status.node ?? t('egressVless') })
              : t('egressVlessNotConfigured')}
          </option>
        </select>
      </div>
      <p style={bodyStyle}>{status?.configured === true
        ? t('egressStatus', { status: status.reachable ? t('egressReady') : t('egressUnavailable') })
        : t('egressConfigureHint')}</p>
      {error === undefined ? null : <p style={errorStyle}>{error}</p>}
    </div>
  )
}
