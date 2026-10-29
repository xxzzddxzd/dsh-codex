import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OpenAICodexService } from '../src/service.ts'
import { GOOGLE_OAUTH_PROVIDER, MANAGED_PROVIDERS, OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from '../src/provider-ids.ts'
import { executeProviderSettings, handleProviderSettingsRequest, PROVIDER_SETTINGS_ACTIONS, providerSettingsError } from '../src/native-panel.ts'
import type { NativeProviderDependencies } from '../src/native-panel.ts'
import { preferenceContext } from './preference-context.ts'
import metadata from '../package.json' with { type: 'json' }

let root: string
let ctx: Context
let subject: OpenAICodexService
let dependencies: NativeProviderDependencies

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-provider-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external request is permitted in native management tests') }))
  ctx = await preferenceContext(root)
  subject = new OpenAICodexService({ modifyReadImage: true, shareImagegenWithOtherModels: true,
    useWebSocketContextReuse: false, useNativeCompaction: false })
  await subject.attachSettings(ctx)
  for (const id of MANAGED_PROVIDERS) subject.modelSettings.registerCatalog(id, async () => [
    { id: 'model-one', name: 'One', defaultContextWindow: 128_000, defaultMaxTokens: 4096 },
    { id: 'model-two', name: 'Two' },
  ])
  dependencies = {
    service: subject,
    codexAuth: { status: vi.fn(async () => ({ status: 'signed-out' })),
      signIn: vi.fn(async () => ({ url: 'https://auth.openai.com/example' })), signOut: vi.fn(async () => {}) },
    xaiAuth: { status: vi.fn(async () => ({ status: 'signing-in' })),
      signIn: vi.fn(async () => ({ url: 'https://accounts.x.ai/example', userCode: 'TEST-CODE' })), signOut: vi.fn(async () => {}) },
  }
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function request(body: unknown) {
  return new Request('http://localhost/api/dsh-provider-settings', { method: 'POST', body: JSON.stringify(body) })
}
async function call(action: string, payload: Record<string, unknown> = {}) {
  return (await handleProviderSettingsRequest(request({ action, payload }), dependencies)).json()
}

describe('native Provider management', () => {
  it('reports the three exact managed identities without reading credentials or quotas', async () => {
    const info = await call('overview')
    expect(info).toMatchObject({ ok: true, value: { settingsReady: true,
      providers: MANAGED_PROVIDERS.map(id => ({ id, features: { auth: true, models: true, egress: true } })),
      components: { bundle: { version: metadata.version }, piAi: { version: '1.4.0' } },
    } })
    expect(dependencies.codexAuth.status).not.toHaveBeenCalled()
    expect(dependencies.xaiAuth.status).not.toHaveBeenCalled()
    expect(PROVIDER_SETTINGS_ACTIONS).toHaveLength(17)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the supplied Web auth controllers for native status, login and logout', async () => {
    expect(await call('auth.status', { provider: OPENAI_CODEX_PROVIDER })).toEqual({ ok: true, value: { status: 'signed-out' } })
    expect(await call('auth.login', { provider: OPENAI_CODEX_PROVIDER })).toMatchObject({ ok: true, value: { url: 'https://auth.openai.com/example' } })
    expect(await call('auth.login', { provider: XAI_PROVIDER })).toMatchObject({ ok: true, value: { userCode: 'TEST-CODE' } })
    expect(await call('auth.logout', { provider: XAI_PROVIDER })).toEqual({ ok: true, value: { ok: true } })
    expect(dependencies.codexAuth.status).toHaveBeenCalledTimes(1)
    expect(dependencies.codexAuth.signIn).toHaveBeenCalledTimes(1)
    expect(dependencies.xaiAuth.signIn).toHaveBeenCalledTimes(1)
    expect(dependencies.xaiAuth.signOut).toHaveBeenCalledTimes(1)
  })

  it('uses the existing Google owner and keeps installed-app client readiness visible', async () => {
    vi.spyOn(subject, 'googleAuthStatus').mockResolvedValue({ authenticated: true })
    vi.spyOn(subject, 'googleOAuthConfigured').mockReturnValue(false)
    const login = vi.spyOn(subject, 'startGoogleLogin').mockResolvedValue({ url: 'https://accounts.google.com/example' })
    const logout = vi.spyOn(subject, 'googleLogout').mockResolvedValue(undefined)
    expect(await call('auth.status', { provider: GOOGLE_OAUTH_PROVIDER })).toEqual({ ok: true, value: { status: 'signed-in', configured: false } })
    expect(await call('auth.login', { provider: GOOGLE_OAUTH_PROVIDER })).toMatchObject({ ok: true })
    expect(await call('auth.logout', { provider: GOOGLE_OAUTH_PROVIDER })).toMatchObject({ ok: true })
    expect(login).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('only returns HTTPS authorization challenges without embedded credentials', async () => {
    for (const url of ['http://example.invalid/auth', 'https://secret@example.invalid/auth']) {
      vi.mocked(dependencies.codexAuth.signIn).mockResolvedValue({ url })
      expect(await call('auth.login', { provider: OPENAI_CODEX_PROVIDER })).toMatchObject({ ok: false,
        error: { message: 'Provider returned an unsafe authorization URL' } })
    }
  })

  it('keeps successful auth projections limited to public fields and redacts status diagnostics', async () => {
    vi.mocked(dependencies.codexAuth.status).mockResolvedValue({ status: 'error',
      message: 'invalid client_secret=private-client', access: 'private-access', refresh: 'private-refresh' })
    expect(await call('auth.status', { provider: OPENAI_CODEX_PROVIDER })).toEqual({ ok: true,
      value: { status: 'error', message: 'invalid client_secret=[redacted]' } })
  })

  it('persists model overrides through the shared authoritative settings scope', async () => {
    expect(await call('models.set', { provider: OPENAI_CODEX_PROVIDER,
      models: [{ id: 'model-one', visible: false, contextWindow: 64_000, maxTokens: 1024 }] })).toMatchObject({
      ok: true, value: { models: [expect.objectContaining({ id: 'model-one', visible: false, maxTokens: 1024 }),
        expect.objectContaining({ id: 'model-two' })] },
    })
    expect(subject.modelSettings.snapshot(OPENAI_CODEX_PROVIDER)).toEqual([
      { id: 'model-one', visible: false, contextWindow: 64_000, maxTokens: 1024 },
    ])
    expect(await call('models.get', { provider: OPENAI_CODEX_PROVIDER })).toMatchObject({ ok: true,
      value: { models: [expect.objectContaining({ visible: false }), expect.objectContaining({ id: 'model-two' })] } })
    expect(await call('models.set', { provider: OPENAI_CODEX_PROVIDER,
      models: [{ id: 'model-one', maxTokens: -1 }] })).toMatchObject({ ok: false })
    expect(await call('models.set', { provider: OPENAI_CODEX_PROVIDER,
      models: [{ id: 'unknown' }] })).toMatchObject({ ok: false })
    expect(subject.modelSettings.snapshot(OPENAI_CODEX_PROVIDER)[0]?.maxTokens).toBe(1024)
  })

  it('shares image, Responses and xAI image selection policy with existing front doors', async () => {
    expect(await call('images.set', { modifyReadImage: false })).toMatchObject({ ok: true, value: { modifyReadImage: false } })
    expect(subject.imagePreferences().modifyReadImage).toBe(false)
    expect(await call('responses.set', { useNativeCompaction: true })).toMatchObject({ ok: true, value: { useNativeCompaction: true } })
    expect(subject.responsePreferences().useNativeCompaction).toBe(true)
    expect(await call('xai-image.set', { model: 'grok-imagine-image-quality' })).toMatchObject({ ok: true,
      value: { model: 'grok-imagine-image-quality', models: expect.any(Array) } })
    expect(subject.policy.xaiImageSnapshot().model).toBe('grok-imagine-image-quality')
    for (const [action, payload] of [
      ['images.set', { modifyReadImage: 'false' }], ['images.set', { unknown: true }],
      ['responses.set', { useStatefulResponses: true }], ['xai-image.set', { model: 'unknown' }],
    ] as const) expect(await call(action, payload)).toMatchObject({ ok: false })
  })

  it('reuses per-provider exit readiness, private VLESS configuration and production speed checks', async () => {
    vi.spyOn(subject.vless, 'status').mockResolvedValue({ configured: true, running: true, reachable: true, node: 'Test node' })
    const ready = vi.spyOn(subject.vless, 'ensureReady').mockResolvedValue(undefined)
    const configure = vi.spyOn(subject.vless, 'configure').mockResolvedValue({ configured: true, running: true, reachable: true })
    const speed = vi.spyOn(subject, 'vlessSpeedTest').mockResolvedValue(32)
    expect(await call('egress.set', { provider: XAI_PROVIDER, egress: 'vless' })).toMatchObject({ ok: true, value: { egress: 'vless' } })
    expect(subject.policy.providerVlessSnapshot(XAI_PROVIDER).useVless).toBe(true)
    expect(subject.policy.providerVlessSnapshot(GOOGLE_OAUTH_PROVIDER).useVless).toBe(false)
    expect(ready).toHaveBeenCalledTimes(1)
    const secretURI = 'vless://test-secret@example.invalid:443'
    expect(await call('vless.configure', { vlessUrl: secretURI })).toMatchObject({ ok: true, value: { node: 'Test node' } })
    expect(configure).toHaveBeenCalledWith(secretURI)
    expect(await call('vless.speed-test')).toMatchObject({ ok: true, value: { latencyMs: 32 } })
    expect(speed).toHaveBeenCalledTimes(1)
    expect(await call('egress.set', { provider: XAI_PROVIDER, egress: 'proxy' })).toMatchObject({ ok: false })
    expect(await call('vless.configure', { vlessUrl: '', arbitraryPath: '/tmp' })).toMatchObject({ ok: false })
  })

  it.each([
    null, [], { action: 'unknown' }, { action: 'overview', payload: null },
    { action: 'overview', arbitraryPath: '/api/other' },
    { action: 'overview', payload: { url: 'https://example.invalid' } },
    { action: 'models.get', payload: { provider: 'provider-google-oauth' } },
    { action: 'auth.status', payload: { provider: 'xai' } },
    { action: 'auth.status', payload: { provider: OPENAI_CODEX_PROVIDER, principal: { kind: 'owner' } } },
  ])('rejects unsupported identities, fields and dispatch input %#', async body => {
    const response = await handleProviderSettingsRequest(request(body), dependencies)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'provider-settings' } })
    expect(dependencies.codexAuth.status).not.toHaveBeenCalled()
  })

  it('bounds UTF-8 request bytes and cancels an oversized streaming body', async () => {
    let cancelled = false
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('中'.repeat(6000))) },
      cancel() { cancelled = true } })
    const response = await handleProviderSettingsRequest(new Request('http://localhost/api/dsh-provider-settings', {
      method: 'POST', body, duplex: 'half',
    } as RequestInit), dependencies)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { message: expect.stringContaining('16 KiB') } })
    expect(cancelled).toBe(true)
    expect(dependencies.codexAuth.signIn).not.toHaveBeenCalled()
  })

  it('redacts upstream authorization failures and never returns a VLESS secret', async () => {
    vi.mocked(dependencies.codexAuth.status).mockRejectedValue(new Error('failure token=private-token refresh_token=refresh-secret Bearer opaque-secret vless://private-node@example.invalid'))
    const response = await call('auth.status', { provider: OPENAI_CODEX_PROVIDER })
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).not.toMatch(/private-token|refresh-secret|opaque-secret|private-node/u)
    expect(providerSettingsError(new Error('access_token=other-secret&client_secret=client-value'))).not.toMatch(/other-secret|client-value/u)
    expect(providerSettingsError(new Error('{"access_token":"json-secret","client_secret": "json-client"}'))).not.toMatch(/json-secret|json-client/u)
  })

  it('does not permit paths or alternate actions through the exported executor', async () => {
    await expect(executeProviderSettings('constructor' as never, {}, dependencies)).rejects.toThrow('Unknown Provider settings action')
  })
})
