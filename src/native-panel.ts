/** Provider management over Connection's authenticated, transport-independent API. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { describeProviderComponents } from './components.ts'
import { GOOGLE_OAUTH_PROVIDER, isManagedProvider, MANAGED_PROVIDERS, OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from './provider-ids.ts'
import type { ManagedProvider } from './provider-ids.ts'
import type { OpenAICodexService } from './service.ts'
import type { ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
import { XAI_IMAGE_MODELS } from './xai-images.ts'

export const PROVIDER_SETTINGS_PATH = '/api/dsh-provider-settings'
export const PROVIDER_SETTINGS_MAX_BODY_BYTES = 16 * 1024
export const PROVIDER_SETTINGS_ACTIONS = [
  'overview', 'auth.status', 'auth.login', 'auth.logout',
  'models.get', 'models.set', 'images.get', 'images.set',
  'responses.get', 'responses.set', 'xai-image.get', 'xai-image.set',
  'egress.get', 'egress.set', 'vless.get', 'vless.configure', 'vless.speed-test',
] as const
export type ProviderSettingsAction = typeof PROVIDER_SETTINGS_ACTIONS[number]

/** These are the same controller instances held by the Web settings routes. */
export interface ProviderAuthLifecycle {
  status(): Promise<unknown>
  signIn(): Promise<{ url: string; userCode?: string }>
  signOut(): Promise<void>
}
export interface NativeProviderDependencies {
  service: OpenAICodexService
  codexAuth: ProviderAuthLifecycle
  xaiAuth: ProviderAuthLifecycle
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown Provider settings field')
}
function provider(value: unknown): ManagedProvider {
  if (!isManagedProvider(value)) throw new Error('Unknown Provider identity')
  return value
}
function booleans(value: Record<string, unknown>, allowed: readonly string[]): Record<string, boolean> {
  fields(value, allowed)
  const result: Record<string, boolean> = {}
  for (const key of allowed) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    result[key] = value[key]
  }
  return result
}
async function challenge(value: Promise<{ url: string; userCode?: string }>): Promise<{ url: string; userCode?: string }> {
  const result = await value
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Provider returned an unsafe authorization URL')
  return { url: result.url, ...(result.userCode === undefined ? {} : { userCode: result.userCode }) }
}

function publicAuthStatus(value: unknown): Record<string, unknown> {
  if (!record(value) || typeof value.status !== 'string' || !['signed-out', 'signing-in', 'signed-in', 'error'].includes(value.status)) {
    throw new Error('Provider returned an unsupported authentication status')
  }
  // The shared controllers already project usage into a secret-free DTO.
  // Do not forward any unrelated internal credential or operation fields.
  return { status: value.status,
    ...(value.status === 'signed-in' && value.usage !== undefined ? { usage: value.usage } : {}),
    ...(typeof value.message === 'string' ? { message: providerSettingsError(value.message) } : {}),
    ...(typeof value.quotaError === 'string' ? { quotaError: providerSettingsError(value.quotaError) } : {}),
  }
}

function imageModels() {
  return XAI_IMAGE_MODELS.map(id => ({ id,
    name: id === 'grok-imagine-image-2.0' ? 'Grok Imagine Image 2.0' : 'Grok Imagine Image Quality' }))
}

/** Only public metadata or explicit user-entered authorization challenges leave the Host. */
export async function executeProviderSettings(
  action: ProviderSettingsAction, payload: Record<string, unknown>,
  { service, codexAuth, xaiAuth }: NativeProviderDependencies,
): Promise<unknown> {
  if (action === 'overview') {
    fields(payload, [])
    const names: Record<ManagedProvider, string> = {
      [OPENAI_CODEX_PROVIDER]: 'Provider Codex', [XAI_PROVIDER]: 'Provider xAI', [GOOGLE_OAUTH_PROVIDER]: 'Provider Google',
    }
    return { components: describeProviderComponents(), settingsReady: service.settingsReady,
      providers: MANAGED_PROVIDERS.map(id => ({ id, name: names[id], features: { auth: true, models: true, egress: true } })) }
  }
  if (action === 'auth.status' || action === 'auth.login' || action === 'auth.logout') {
    fields(payload, ['provider'])
    const id = provider(payload.provider)
    if (id === GOOGLE_OAUTH_PROVIDER) {
      if (action === 'auth.status') return {
        status: (await service.googleAuthStatus()).authenticated ? 'signed-in' : 'signed-out',
        configured: service.googleOAuthConfigured(),
      }
      if (action === 'auth.login') return challenge(service.startGoogleLogin())
      await service.googleLogout()
    } else {
      const auth = id === OPENAI_CODEX_PROVIDER ? codexAuth : xaiAuth
      if (action === 'auth.status') return publicAuthStatus(await auth.status())
      if (action === 'auth.login') return challenge(auth.signIn())
      await auth.signOut()
    }
    return { ok: true }
  }
  if (action === 'models.get' || action === 'models.set') {
    fields(payload, action === 'models.set' ? ['provider', 'models'] : ['provider'])
    const id = provider(payload.provider)
    if (action === 'models.set') await service.modelSettings.update(id, payload.models)
    return { models: await service.modelSettings.catalog(id) }
  }
  if (action === 'images.get') { fields(payload, []); return service.imagePreferences() }
  if (action === 'images.set') {
    return service.updateImagePreferences(booleans(payload, ['modifyReadImage', 'shareImagegenWithOtherModels']) as Partial<ImageToolPreferences>)
  }
  if (action === 'responses.get') { fields(payload, []); return service.responsePreferences() }
  if (action === 'responses.set') {
    return service.updateResponsePreferences(booleans(payload, ['useWebSocketContextReuse', 'useNativeCompaction']) as Partial<ResponseApiPreferences>)
  }
  if (action === 'xai-image.get' || action === 'xai-image.set') {
    fields(payload, action === 'xai-image.set' ? ['model'] : [])
    const preferences = action === 'xai-image.set'
      ? await service.policy.updateXaiImageModel(payload.model)
      : service.policy.xaiImageSnapshot()
    return { ...preferences, models: imageModels() }
  }
  if (action === 'egress.get' || action === 'egress.set') {
    fields(payload, action === 'egress.set' ? ['provider', 'egress'] : ['provider'])
    const id = provider(payload.provider)
    if (action === 'egress.get') return service.providerVlessStatus(id)
    if (payload.egress !== 'direct' && payload.egress !== 'vless') throw new Error('egress must be direct or vless')
    return service.updateProviderEgress(id, payload.egress)
  }
  if (action === 'vless.get') { fields(payload, []); return service.vlessStatus() }
  if (action === 'vless.configure') {
    fields(payload, ['vlessUrl'])
    if (typeof payload.vlessUrl !== 'string' || !payload.vlessUrl.trim() || payload.vlessUrl.length > 8192) {
      throw new Error('vlessUrl must be a non-empty VLESS URI of at most 8192 characters')
    }
    await service.vless.configure(payload.vlessUrl)
    return service.vlessStatus()
  }
  if (action === 'vless.speed-test') {
    fields(payload, [])
    return { ...await service.vlessStatus(), latencyMs: await service.vlessSpeedTest() }
  }
  throw new Error('Unknown Provider settings action')
}

/** Do not reflect credentials or authorization parameters in API failures. */
export function providerSettingsError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/vless:\/\/[^\s"'<>]+/giu, 'vless://[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token|client_secret|api_key)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [redacted]')
    .replace(/(["'](?:code|token|refresh_token|access_token|client_secret|api_key)["']\s*:\s*["'])[^"']*(["'])/giu, '$1[redacted]$2')
    .slice(0, 1000)
}

async function requestValue(request: Request): Promise<{ action: ProviderSettingsAction; payload: Record<string, unknown> }> {
  if (!request.body) throw new Error('Provider settings body must be a JSON object')
  const reader = request.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > PROVIDER_SETTINGS_MAX_BODY_BYTES) throw new Error('Provider settings body exceeds 16 KiB')
      chunks.push(next.value)
    }
  } finally {
    // Also stops an oversized HTTP stream before it is buffered in full.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('Provider settings body must be valid JSON') }
  if (!record(value)) throw new Error('Provider settings body must be a JSON object')
  fields(value, ['action', 'payload'])
  if (typeof value.action !== 'string' || !(PROVIDER_SETTINGS_ACTIONS as readonly string[]).includes(value.action)) {
    throw new Error('Unknown Provider settings action')
  }
  if (value.payload !== undefined && !record(value.payload)) throw new Error('Provider settings payload must be an object')
  return { action: value.action as ProviderSettingsAction, payload: value.payload ?? {} }
}

/** Exported handler enables behavioral tests without a second business or auth owner. */
export async function handleProviderSettingsRequest(request: Request, dependencies: NativeProviderDependencies): Promise<Response> {
  try {
    const { action, payload } = await requestValue(request)
    return Response.json({ ok: true, value: await executeProviderSettings(action, payload, dependencies) }, {
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  } catch (error: unknown) {
    return Response.json({ ok: false, error: { code: 'provider-settings', message: providerSettingsError(error) } }, {
      status: 400, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  }
}

/** Connection's Fetch carrier admits only owner Peers before invoking this exact route. */
export function registerNativeProviderPanel(ctx: Context, dependencies: NativeProviderDependencies): void {
  ctx.inject(['connection'], connectionCtx => connectionCtx.connection.fetch.register({
    path: PROVIDER_SETTINGS_PATH,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => handleProviderSettingsRequest(request, dependencies),
  }))
}
