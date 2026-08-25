/** Same-origin Web settings routes for OpenAI Codex OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  loginOpenAICodex,
  loginXai,
  logoutOpenAICodex,
  logoutXai,
  openAICodexAuthStatus,
  xaiAuthStatus,
} from './auth.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import type { XaiCredentialStore } from './store.ts'
import type { ImageToolPolicy, ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import type { OpenAICodexService } from './service.ts'
import { MANAGED_PROVIDERS } from './provider-ids.ts'
import type { ManagedProvider } from './provider-ids.ts'
import { XAI_IMAGE_MODELS } from './xai-images.ts'

/** Plugin-owned status endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
/** Plugin-owned browser-login endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
/** Plugin-owned logout endpoint consumed by its browser half. */
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
/** Plugin-owned image-tool preference endpoint consumed by its browser half. */
export const OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH = '/plugins/dsh-openai-codex/image-tools'
/** Plugin-owned Responses API experiment endpoint consumed by its browser half. */
export const OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH = '/plugins/dsh-openai-codex/response-api'
/** Plugin-owned proxy endpoint consumed by its browser half. */
export const OPENAI_CODEX_PROXY_SETTINGS_PATH = '/plugins/dsh-openai-codex/proxy'
/** pi-ai xAI OAuth endpoints consumed by its Provider subpage. */
export const XAI_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/providers/xai/auth/status'
export const XAI_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/providers/xai/auth/login'
export const XAI_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/providers/xai/auth/logout'
/** xAI image-model selection consumed by the xAI Provider subpage. */
export const XAI_IMAGE_MODEL_SETTINGS_PATH = '/plugins/dsh-openai-codex/providers/xai/image-model'
/** @kelvinwww/dsh-oauth Google endpoints consumed by its Provider subpage. */
export const GOOGLE_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/providers/google/auth/status'
export const GOOGLE_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/providers/google/auth/login'
export const GOOGLE_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/providers/google/auth/logout'

/** Same-origin exit endpoint for one exact provider route. */
export function providerEgressPath(provider: ManagedProvider): string {
  return `/plugins/dsh-openai-codex/providers/${encodeURIComponent(provider)}/egress`
}

export type OpenAICodexWebAuthStatus =
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'error'; message: string }

interface LoginChallenge {
  url: string
  userCode?: string
}

/** Redact provider diagnostics before they cross to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/vless:\/\/[^\s"'<>]+/giu, 'vless://[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 1000)
}

/** Reject with the prompt's abort reason while browser callback owns completion. */
function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

/** One lifecycle owner for the callback server, challenge, and public status. */
export class OpenAICodexWebAuth {
  private state: OpenAICodexWebAuthStatus = { status: 'signed-out' }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  constructor(private readonly store: OpenAICodexCredentialStore) {}

  /** Read current public state, consulting durable storage while idle. */
  async status(): Promise<OpenAICodexWebAuthStatus> {
    if (this.operation !== undefined) return this.state
    if (this.state.status === 'error') return this.state
    return this.readStoredStatus()
  }

  /** Start or join the current browser-login operation. */
  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => {
      this.challengeWaiters.push({ resolve, reject })
    })
  }

  /** Cancel any callback listener, wait for quiescence, then delete the credential. */
  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await logoutOpenAICodex(this.store)
    this.state = { status: 'signed-out' }
  }

  /** Stop the owned callback listener during plugin disposal. */
  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex plugin disposed'))
    await this.operation?.catch(() => undefined)
  }

  private start(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.challenge = undefined
    this.state = { status: 'signing-in' }
    this.operation = loginOpenAICodex({
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve('browser')
        : waitForPromptAbort(prompt),
      notify: event => { this.onEvent(event) },
    }, this.store).then(
      async () => {
        this.state = await this.readStoredStatus()
      },
      (error: unknown) => {
        this.rejectChallenge(error)
        this.state = { status: 'error', message: safeMessage(error) }
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type !== 'auth_url') return
    const url = new URL(event.url)
    if (url.protocol !== 'https:') {
      const error = new Error('OpenAI returned an unsafe authorization URL')
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    const challenge = { url: event.url }
    this.challenge = challenge
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge)
  }

  private async readStoredStatus(): Promise<OpenAICodexWebAuthStatus> {
    const stored = await openAICodexAuthStatus(this.store)
    if (!stored.authenticated) return { status: 'signed-out' }
    try {
      return { status: 'signed-in', usage: await readOpenAICodexRateLimits(this.store) }
    } catch (error: unknown) {
      return { status: 'signed-in', usage: { rateLimits: [] }, quotaError: safeMessage(error) }
    }
  }

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

/** Browser-facing lifecycle for pi-ai's xAI device-code OAuth flow. */
export class XaiWebAuth {
  private state: 'signed-out' | 'signing-in' | 'signed-in' | 'error' = 'signed-out'
  private message: string | undefined
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  constructor(private readonly store: XaiCredentialStore) {}

  async status(): Promise<{ status: 'signed-out' | 'signing-in' | 'signed-in' | 'error'; message?: string }> {
    if (this.operation !== undefined) return { status: this.state, ...(this.message === undefined ? {} : { message: this.message }) }
    if (this.state === 'error') return { status: 'error', ...(this.message === undefined ? {} : { message: this.message }) }
    return { status: (await xaiAuthStatus(this.store)).authenticated ? 'signed-in' : 'signed-out' }
  }

  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => { this.challengeWaiters.push({ resolve, reject }) })
  }

  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('xAI sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await logoutXai(this.store)
    this.state = 'signed-out'
    this.message = undefined
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('xAI provider disposed'))
    await this.operation?.catch(() => undefined)
  }

  private start(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.challenge = undefined
    this.message = undefined
    this.state = 'signing-in'
    this.operation = loginXai({
      signal: cancellation.signal,
      prompt: waitForPromptAbort,
      notify: event => { this.onEvent(event) },
    }, this.store).then(
      () => { this.state = 'signed-in' },
      (error: unknown) => {
        this.rejectChallenge(error)
        this.message = safeMessage(error)
        this.state = 'error'
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    const detail = event.type === 'auth_url'
      ? { url: event.url }
      : event.type === 'device_code'
        ? { url: event.verificationUri, userCode: event.userCode }
        : undefined
    if (detail === undefined) return
    const url = new URL(detail.url)
    if (url.protocol !== 'https:') {
      const error = new Error('xAI returned an unsafe authorization URL')
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    this.challenge = detail
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(detail)
  }

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

/** Whether a request comes from this loopback page rather than a remote site. */
function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > 16 * 1024) throw new Error('request body is too large')
    chunks.push(data)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function preferencePatch(value: Record<string, unknown>): Partial<ImageToolPreferences> {
  const allowed = new Set(['modifyReadImage', 'shareImagegenWithOtherModels'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('request contains an unknown image-tool setting')
  const patch: Partial<ImageToolPreferences> = {}
  for (const key of allowed as Set<keyof ImageToolPreferences>) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

function responseApiPatch(value: Record<string, unknown>): Partial<ResponseApiPreferences> {
  const allowed = new Set<keyof ResponseApiPreferences>(['useWebSocketContextReuse', 'useNativeCompaction'])
  if (Object.keys(value).some(key => !allowed.has(key as keyof ResponseApiPreferences))) {
    throw new Error('request contains an unknown Responses API setting')
  }
  const patch: Partial<ResponseApiPreferences> = {}
  for (const key of allowed) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

/** Register the plugin-owned OAuth routes when the Web server is composed. */
export function registerOpenAICodexAuthRoutes(
  ctx: Context,
  store: OpenAICodexCredentialStore,
  imageTools: ImageToolPolicy,
  service: OpenAICodexService,
): void {
  const auth = new OpenAICodexWebAuth(store)
  const xaiAuth = new XaiWebAuth(service.xaiCredentials)
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            json(res, 200, await auth.signIn())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          await auth.signOut()
          json(res, 200, { ok: true })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await xaiAuth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            json(res, 200, await xaiAuth.signIn())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          await xaiAuth.signOut()
          json(res, 200, { ok: true })
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_IMAGE_MODEL_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') {
            return json(res, 200, {
              ...imageTools.xaiImageSnapshot(),
              models: XAI_IMAGE_MODELS.map(id => ({
                id,
                name: id === 'grok-imagine-image-2.0' ? 'Grok Imagine Image 2.0' : 'Grok Imagine Image Quality',
              })),
            })
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const body = await readJson(req)
            if (Object.keys(body).length !== 1) throw new Error('request must contain only model')
            json(res, 200, {
              ...await imageTools.updateXaiImageModel(body.model),
              models: XAI_IMAGE_MODELS.map(id => ({
                id,
                name: id === 'grok-imagine-image-2.0' ? 'Grok Imagine Image 2.0' : 'Grok Imagine Image Quality',
              })),
            })
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: GOOGLE_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            const status = await service.googleAuthStatus()
            json(res, 200, {
              status: status.authenticated ? 'signed-in' : 'signed-out',
              configured: service.googleOAuthConfigured(),
            })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: GOOGLE_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            json(res, 200, await service.startGoogleLogin())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: GOOGLE_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            await service.googleLogout()
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ...MANAGED_PROVIDERS.map(provider => ctx.webServer.register({
        kind: 'exact' as const,
        path: providerEgressPath(provider),
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, await service.providerVlessStatus(provider))
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const body = await readJson(req)
            if (Object.keys(body).length !== 1 || (body.egress !== 'direct' && body.egress !== 'vless')) {
              throw new Error('request must contain only egress set to direct or vless')
            }
            json(res, 200, await service.updateProviderEgress(provider, body.egress))
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      })),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, imageTools.snapshot())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            json(res, 200, await imageTools.update(preferencePatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, imageTools.responseApiSnapshot())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            json(res, 200, await imageTools.updateResponseApi(responseApiPatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_PROXY_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, await service.vlessStatus())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const body = await readJson(req)
            const allowed = new Set(['egress', 'enabled', 'vlessUrl', 'speedTest'])
            if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('request contains an unknown VLESS setting')
            if (body.speedTest !== undefined) {
              if (body.speedTest !== true || Object.keys(body).length !== 1) {
                throw new Error('speedTest must be the only setting and must be true')
              }
              const latencyMs = await service.vlessSpeedTest()
              return json(res, 200, { ...await service.vlessStatus(), latencyMs })
            }
            if (body.vlessUrl !== undefined) {
              if (typeof body.vlessUrl !== 'string' || body.vlessUrl.trim() === '') {
                throw new Error('vlessUrl must be a non-empty string')
              }
              await service.vless.configure(body.vlessUrl)
            }
            if (body.egress !== undefined) {
              if (body.egress !== 'direct' && body.egress !== 'vless') {
                throw new Error('egress must be direct or vless')
              }
              if (body.enabled !== undefined) throw new Error('request cannot include both egress and enabled')
              return json(res, 200, await service.updateEgress(body.egress))
            }
            if (body.enabled !== undefined) {
              if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean')
              return json(res, 200, await service.updateVlessEnabled(body.enabled))
            }
            if (body.vlessUrl === undefined) throw new Error('request must include egress, enabled, vlessUrl, or speedTest')
            json(res, 200, await service.vlessStatus())
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      await auth.dispose()
      await xaiAuth.dispose()
    }
  }, 'dsh-providers: Web OAuth and network routes')
}
