/** Shared host service consumed by optional OpenAI Codex front-door adapters. */

import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
import type { OpenAICodexAuthStatus } from './auth.ts'
import { OpenAICodexCredentialStore } from './store.ts'
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

/**
 * One provider-owned host service shared by Web routes and terminal adapters.
 * Credentials and live policy stay singletons even when several front doors are mounted.
 */
export class OpenAICodexService {
  readonly credentials = new OpenAICodexCredentialStore()
  readonly policy: ImageToolPolicy
  readonly vless: VlessController
  private proxy: OpenAICodexProxyHandle | undefined

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
  async vlessStatus(): Promise<VlessStatus & { enabled: boolean }> {
    return { ...await this.vless.status(), enabled: this.policy.vlessSnapshot().useVless }
  }

  /** Persist the Codex-only VLESS routing switch after readiness is checked. */
  async updateVlessEnabled(enabled: boolean): Promise<VlessStatus & { enabled: boolean }> {
    if (enabled) await this.vless.ensureReady()
    await this.policy.updateVless(enabled)
    return this.vlessStatus()
  }

  /** Measure the warm, production VLESS agent rather than a temporary client. */
  async vlessSpeedTest(): Promise<number> {
    if (!await this.vless.status().then(status => status.configured)) {
      throw new Error('Save and test a VLESS node before testing its speed')
    }
    if (this.proxy === undefined) throw new Error('OpenAI Codex proxy is unavailable')
    return this.proxy.speedTest()
  }
}
