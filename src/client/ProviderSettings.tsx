/** Provider hub with one settings subpage per subscription provider. */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  GOOGLE_OAUTH_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  XAI_PROVIDER,
} from '../provider-ids.ts'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { ProviderEgressSettings } from './ProviderEgress.tsx'
import { ProviderModels } from './ProviderModels.tsx'
import type { ProviderSettingsKey } from './provider-locales.ts'

type ProviderPage = 'openai' | 'xai' | 'google'

interface AccountStatus {
  status: 'loading' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'
  message?: string
  configured?: boolean
}

interface LoginChallenge {
  url: string
  userCode?: string
}

export interface ProviderSettingsInjected {
  t: (key: ProviderSettingsKey, params?: Record<string, unknown>) => string
  openaiT: OpenAICodexSettingsInjected['t']
}

export type ProviderSettingsProps = Partial<ProviderSettingsInjected>

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardsStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const cardStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const providerInfoStyle: CSSProperties = { minWidth: 0, flex: '1 1 auto' }
const providerNameStyle: CSSProperties = { fontSize: 15, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-button-primary-fill)', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
const accountCardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const accountRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const selectStyle: CSSProperties = { boxSizing: 'border-box', minWidth: 250, minHeight: 36, padding: '6px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14 }

function dotStyle(status: AccountStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-label-tertiary)'
  return { width: 8, height: 8, flex: '0 0 auto', borderRadius: 999, background: color }
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
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
  return value as T
}

interface XaiImageSettingsValue {
  model: string
  models: Array<{ id: string; name: string }>
}

function XaiImageSettings({ t }: { t: ProviderSettingsInjected['t'] }) {
  const path = '/plugins/dsh-openai-codex/providers/xai/image-model'
  const [value, setValue] = useState<XaiImageSettingsValue | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    void jsonRequest<XaiImageSettingsValue>(path).then(
      next => { if (active) setValue(next) },
      cause => { if (active) setError(cause instanceof Error ? cause.message : t('imageModelFailed')) },
    )
    return () => { active = false }
  }, [t])

  const update = async (model: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setValue(await jsonRequest<XaiImageSettingsValue>(path, 'POST', { model }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('imageModelFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={accountCardStyle}>
      <div>
        <div style={providerNameStyle}>{t('imageModel')}</div>
        <p style={{ ...bodyStyle, marginTop: 3 }}>{t('imageModelHint')}</p>
      </div>
      <label style={{ ...accountRowStyle, justifyContent: 'flex-start' }}>
        <span style={bodyStyle}>{t('imageModelLabel')}</span>
        <select
          aria-label={t('imageModelLabel')}
          style={selectStyle}
          disabled={value === undefined || busy}
          value={value?.model ?? ''}
          onChange={event => { void update(event.currentTarget.value) }}
        >
          {value?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {error === undefined ? null : <p style={errorStyle}>{error}</p>}
    </div>
  )
}

function ProviderCard({ name, description, t, onOpen }: {
  name: string
  description: string
  t: ProviderSettingsInjected['t']
  onOpen: () => void
}) {
  return (
    <div style={cardStyle}>
      <div style={providerInfoStyle}>
        <div style={providerNameStyle}>{name}</div>
        <p style={{ ...bodyStyle, marginTop: 3 }}>{description}</p>
      </div>
      <button type="button" style={buttonStyle} onClick={onOpen}>{t('configure')} ›</button>
    </div>
  )
}

function SubpageHeader({ title, source, t, onBack }: {
  title: string
  source: string
  t: ProviderSettingsInjected['t']
  onBack: () => void
}) {
  return (
    <div>
      <button type="button" style={{ ...buttonStyle, marginBottom: 12 }} onClick={onBack}>‹ {t('back')}</button>
      <h2 style={titleStyle}>{title}</h2>
      <p style={{ ...bodyStyle, marginTop: 6 }}>{source}</p>
    </div>
  )
}

function OAuthProviderPage({ kind, t, onBack }: {
  kind: 'xai' | 'google'
  t: ProviderSettingsInjected['t']
  onBack: () => void
}) {
  const xai = kind === 'xai'
  const name = xai ? t('xaiName') : t('googleName')
  const root = `/plugins/dsh-openai-codex/providers/${kind}/auth`
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [userCode, setUserCode] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await jsonRequest<AccountStatus>(`${root}/status`)
        if (active) { setStatus(next); setStatusError(undefined) }
      } catch (cause: unknown) {
        if (active) setStatusError(cause instanceof Error ? cause.message : t('accountFailed'))
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 1_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [root, t])

  const signIn = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup === null) { setActionError(t('popupBlocked')); return }
    setBusy(true)
    setActionError(undefined)
    setUserCode(undefined)
    try {
      const challenge = await jsonRequest<LoginChallenge>(`${root}/login`, 'POST')
      setUserCode(challenge.userCode)
      popup.location.href = challenge.url
    } catch (cause: unknown) {
      popup.close()
      setActionError(cause instanceof Error ? cause.message : t('accountFailed'))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setActionError(undefined)
    try {
      await jsonRequest(`${root}/logout`, 'POST')
      setStatus({
        status: 'signed-out',
        ...status.configured === undefined ? {} : { configured: status.configured },
      })
      setUserCode(undefined)
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : t('accountFailed'))
    } finally {
      setBusy(false)
    }
  }

  const label = status.status === 'loading'
    ? t('loading')
    : status.status === 'signed-in'
      ? t('signedIn')
      : status.status === 'signing-in'
        ? t('signingIn')
        : t('signedOut')
  const googleUnconfigured = !xai && status.configured === false

  return (
    <section style={pageStyle}>
      <SubpageHeader title={name} source={xai ? t('sourcePi') : t('sourceGoogle')} t={t} onBack={onBack} />
      <div style={accountCardStyle}>
        <div style={accountRowStyle}>
          <div style={statusStyle} role="status">
            <span aria-hidden="true" style={dotStyle(status.status)} />
            <span>{label}</span>
          </div>
          {status.status === 'signed-in'
            ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void signOut() }}>{busy ? t('working') : t('logout')}</button>
            : <button type="button" style={primaryButtonStyle} disabled={busy || status.status === 'signing-in' || googleUnconfigured} onClick={() => { void signIn() }}>{busy ? t('working') : status.status === 'error' ? t('loginAgain') : xai ? t('loginXai') : t('loginGoogle')}</button>}
        </div>
        {userCode === undefined ? null : <p style={bodyStyle}>{t('deviceCode', { code: userCode })}</p>}
        {googleUnconfigured ? <p role="alert" style={errorStyle}>{t('googleNotConfigured')}</p> : null}
        {status.status === 'error' && status.message !== undefined ? <p style={errorStyle}>{status.message}</p> : null}
        {statusError === undefined ? null : <p role="alert" style={errorStyle}>{statusError}</p>}
        {actionError === undefined ? null : <p role="alert" style={errorStyle}>{actionError}</p>}
      </div>
      {xai ? <XaiImageSettings t={t} /> : null}
      <ProviderModels provider={xai ? XAI_PROVIDER : GOOGLE_OAUTH_PROVIDER} t={t} />
      <ProviderEgressSettings provider={xai ? XAI_PROVIDER : GOOGLE_OAUTH_PROVIDER} t={t} />
    </section>
  )
}

/** Render the Provider landing page and its three independent subpages. */
export function ProviderSettings({ t, openaiT }: ProviderSettingsProps) {
  if (t === undefined || openaiT === undefined) throw new Error('Provider settings requires both translation functions')
  const [page, setPage] = useState<ProviderPage | undefined>()
  if (page === 'openai') {
    return (
      <section style={pageStyle}>
        <SubpageHeader title={t('openaiName')} source={t('sourcePi')} t={t} onBack={() => { setPage(undefined) }} />
        <OpenAICodexSettings t={openaiT} hideHeader />
        <ProviderModels provider={OPENAI_CODEX_PROVIDER} t={t} />
      </section>
    )
  }
  if (page === 'xai' || page === 'google') return <OAuthProviderPage kind={page} t={t} onBack={() => { setPage(undefined) }} />
  return (
    <section style={pageStyle} aria-labelledby="provider-settings-title">
      <div>
        <h2 id="provider-settings-title" style={titleStyle}>{t('title')}</h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>
      <div style={cardsStyle}>
        <ProviderCard name={t('openaiName')} description={t('openaiDescription')} t={t} onOpen={() => { setPage('openai') }} />
        <ProviderCard name={t('xaiName')} description={t('xaiDescription')} t={t} onOpen={() => { setPage('xai') }} />
        <ProviderCard name={t('googleName')} description={t('googleDescription')} t={t} onOpen={() => { setPage('google') }} />
      </div>
    </section>
  )
}
