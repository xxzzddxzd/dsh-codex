/** Shared host service consumed by optional OpenAI Codex front-door adapters. */

import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import {
  loginOpenAICodex,
  loginXai,
  logoutOpenAICodex,
  logoutXai,
  openAICodexAuthStatus,
  xaiAuthStatus,
} from './auth.ts'
import type { OpenAICodexAuthStatus } from './auth.ts'
import type { XaiAuthStatus } from './auth.ts'
import { OpenAICodexCredentialStore, XaiCredentialStore } from './store.ts'
import { ImageToolPolicy } from './tool-policy.ts'
import type {
  ImageToolPreferences,
  ResponseApiPreferences,
} from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import { VlessController } from './vless-controller.ts'
import type { VlessControllerOptions, VlessStatus } from './vless-controller.ts'
import type { OpenAICodexProxyHandle } from './proxy.ts'
import { OPENAI_CODEX_PROVIDER } from './provider-ids.ts'
import type { ManagedProvider } from './provider-ids.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider-owned account and preference service for optional front doors. */
    openAICodex: OpenAICodexService
  }
}

/** Initial settings contributed by the bundle configuration. */
export interface OpenAICodexServiceOptions extends ImageToolPreferences, ResponseApiPreferences {
  vless?: VlessControllerOptions
}

/** User-selectable network exits currently available to OpenAI Codex. */
export type ProviderEgress = 'direct' | 'vless'
/** Backward-compatible alias for the original single-provider API. */
export type OpenAICodexEgress = ProviderEgress

/** Secret-free VLESS state plus the provider's current exit selection. */
export interface OpenAICodexVlessStatus extends VlessStatus {
  enabled: boolean
  egress: OpenAICodexEgress
}

/** Provider-neutral view returned by every provider exit endpoint. */
export type ProviderVlessStatus = OpenAICodexVlessStatus

/** Subset of @kelvinwww/dsh-oauth's Google service owned by this bundle. */
export interface GoogleOAuthService {
  startGeminiLogin(): Promise<{ authUrl: string }>
  isAuthenticated(): Promise<boolean>
  logout(): Promise<void>
  dispose(): Promise<void>
}

/**
 * One provider-owned host service shared by Web routes and terminal adapters.
 * Credentials and live policy stay singletons even when several front doors are mounted.
 */
export class OpenAICodexService {
  readonly credentials = new OpenAICodexCredentialStore()
  readonly xaiCredentials = new XaiCredentialStore()
  readonly policy: ImageToolPolicy
  readonly vless: VlessController
  private proxy: OpenAICodexProxyHandle | undefined
  private google: GoogleOAuthService | undefined

  constructor(options: OpenAICodexServiceOptions) {
    this.policy = new ImageToolPolicy(options)
    this.vless = new VlessController(options.vless)
  }

  /** Attach the durable settings document when the active profile provides it. */
  attachSettings(ctx: Context): void {
    this.policy.attach(ctx)
  }

  /** Attach the same long-lived proxy agent used by production Codex requests. */
  attachProxy(proxy: OpenAICodexProxyHandle): void {
    this.proxy = proxy
  }

  /** Attach the Google Code Assist OAuth service supplied by dsh-oauth. */
  attachGoogle(service: GoogleOAuthService): void {
    this.google = service
  }

  /** Start the provider-native OAuth lifecycle. */
  login(interaction: AuthInteraction): Promise<void> {
    return loginOpenAICodex(interaction, this.credentials)
  }

  /** Remove this plugin's credential without touching Codex CLI/Desktop. */
  logout(): Promise<void> {
    return logoutOpenAICodex(this.credentials)
  }

  /** Read non-secret authentication metadata. */
  authStatus(): Promise<OpenAICodexAuthStatus> {
    return openAICodexAuthStatus(this.credentials)
  }

  /** Start pi-ai's native xAI subscription OAuth flow. */
  loginXai(interaction: AuthInteraction): Promise<void> {
    return loginXai(interaction, this.xaiCredentials)
  }

  logoutXai(): Promise<void> {
    return logoutXai(this.xaiCredentials)
  }

  xaiAuthStatus(): Promise<XaiAuthStatus> {
    return xaiAuthStatus(this.xaiCredentials)
  }

  /** Start Google Code Assist OAuth using @kelvinwww/dsh-oauth. */
  startGoogleLogin(): Promise<{ url: string }> {
    if (this.google === undefined) return Promise.reject(new Error('Google OAuth service is unavailable'))
    return this.google.startGeminiLogin().then(({ authUrl }) => ({ url: authUrl }))
  }

  /** Whether Kelvin's Google OAuth flow has its required installed-app client. */
  googleOAuthConfigured(): boolean {
    return Boolean(process.env.GEMINI_CLIENT_ID?.trim() && process.env.GEMINI_CLIENT_SECRET?.trim())
  }

  async googleAuthStatus(): Promise<{ authenticated: boolean }> {
    return { authenticated: await this.requireGoogle().isAuthenticated() }
  }

  googleLogout(): Promise<void> {
    return this.requireGoogle().logout()
  }

  /** Read current subscription limits without issuing a model request. */
  usage(): Promise<OpenAICodexUsage> {
    return readOpenAICodexRateLimits(this.credentials)
  }

  imagePreferences(): ImageToolPreferences {
    return this.policy.snapshot()
  }

  updateImagePreferences(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    return this.policy.update(patch)
  }

  responsePreferences(): ResponseApiPreferences {
    return this.policy.responseApiSnapshot()
  }

  updateResponsePreferences(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    return this.policy.updateResponseApi(patch)
  }

  /** Read the public, secret-free VLESS state exposed in Settings. */
  async vlessStatus(): Promise<OpenAICodexVlessStatus> {
    return this.providerVlessStatus(OPENAI_CODEX_PROVIDER)
  }

  /** Read shared VLESS health plus one provider's independent exit. */
  async providerVlessStatus(provider: ManagedProvider): Promise<ProviderVlessStatus> {
    const enabled = provider === OPENAI_CODEX_PROVIDER
      ? this.policy.vlessSnapshot().useVless
      : this.policy.providerVlessSnapshot(provider).useVless
    return { ...await this.vless.status(), enabled, egress: enabled ? 'vless' : 'direct' }
  }

  /** Persist the Codex-only VLESS routing switch after readiness is checked. */
  async updateVlessEnabled(enabled: boolean): Promise<OpenAICodexVlessStatus> {
    if (enabled) await this.vless.ensureReady()
    await this.policy.updateVless(enabled)
    return this.vlessStatus()
  }

  /** Persist the provider-facing network exit selection. */
  updateEgress(egress: OpenAICodexEgress): Promise<OpenAICodexVlessStatus> {
    return this.updateVlessEnabled(egress === 'vless')
  }

  /** Validate and persist one provider's selected network exit. */
  async updateProviderEgress(provider: ManagedProvider, egress: ProviderEgress): Promise<ProviderVlessStatus> {
    if (provider === OPENAI_CODEX_PROVIDER) return this.updateEgress(egress)
    if (egress === 'vless') await this.vless.ensureReady()
    await this.policy.updateProviderVless(provider, egress === 'vless')
    return this.providerVlessStatus(provider)
  }

  /** Measure the warm, production VLESS agent rather than a temporary client. */
  async vlessSpeedTest(): Promise<number> {
    if (!await this.vless.status().then(status => status.configured)) {
      throw new Error('Save and test a VLESS node before testing its speed')
    }
    if (this.proxy === undefined) throw new Error('OpenAI Codex proxy is unavailable')
    return this.proxy.speedTest()
  }

  private requireGoogle(): GoogleOAuthService {
    if (this.google === undefined) throw new Error('Google OAuth service is unavailable')
    return this.google
  }
}
