/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module dsh-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { ConfigurableProviderAdapter } from './model-preferences.ts'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
  createGeminiService,
} from '@kelvinwww/dsh-oauth/gemini'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { installProviderProxy } from './proxy.ts'
import { createOpenAICodexAdapter, createXaiAdapter } from './adapter.ts'
import { registerOpenAICodexAuthRoutes } from './auth-routes.ts'
import { installReadImageEnhancement } from './read-image-enhancement.ts'
import { imagegenTool } from './imagegen.ts'
import { ImageToolPolicy } from './tool-policy.ts'
import {
  installOpenAICodexSearchEvent,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'

export { READ_IMAGE_TOOL_NAME } from './read-image-enhancement.ts'
export {
  IMAGEGEN_TOOL_NAME,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexImageClient,
  XAI_IMAGE_EDITS_URL,
  XAI_IMAGE_GENERATIONS_URL,
  XaiImageClient,
} from './imagegen.ts'
export {
  DEFAULT_XAI_IMAGE_MODEL,
  XAI_IMAGE_MODELS,
} from './xai-images.ts'
export type { XaiImageModel } from './xai-images.ts'
export {
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  DEFAULT_VLESS_PREFERENCES,
  ImageToolPolicy,
} from './tool-policy.ts'
export type { ImageToolPreferences, ResponseApiPreferences, VlessPreferences } from './tool-policy.ts'
export { OPENAI_CODEX_USAGE_URL, parseOpenAICodexUsage, readOpenAICodexRateLimits } from './usage.ts'
export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexUsage,
} from './usage.ts'
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
  recordOpenAICodexSearchRequest,
} from './search-event.ts'
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from './search.ts'
import type { OpenAICodexSearchContextSize, OpenAICodexSearchMode } from './search.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexService } from './service.ts'
import { GOOGLE_OAUTH_PROVIDER, XAI_PROVIDER } from './provider-ids.ts'
import type { AdapterRegistrationHandle, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createRoutedGeminiOAuthClient, ProviderGoogleAdapter } from './google-oauth.ts'
import { assertCurrentPiXaiImageCatalog } from './xai-images.ts'

export { OpenAICodexService } from './service.ts'
export type { OpenAICodexServiceOptions } from './service.ts'

export { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
export type { OpenAICodexAuthStatus } from './auth.ts'
export {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_PROVIDER,
  XAI_AUTH_FILENAME,
  XAI_PROVIDER,
  XaiCredentialStore,
  openAICodexAuthPath,
  xaiAuthPath,
} from './store.ts'
export {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_SEARCH_PROVIDER,
  OPENAI_CODEX_SEARCH_URL,
} from './search.ts'
export type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
  OpenAICodexSearchRequestRecord,
} from './search.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex'

/** LLM and web registries required before the composite provider can register. */
export const inject = ['llm', 'web']

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Model used for auxiliary standalone searches. */
  searchModel?: string
  /** Cached, indexed, or live web access. */
  searchMode?: OpenAICodexSearchMode
  /** Amount of search context returned by the provider. */
  searchContextSize?: OpenAICodexSearchContextSize
  /** Maximum generated tokens returned by the standalone search endpoint. */
  searchMaxOutputTokens?: number
  /** Extend Harness read_image with HTTP(S) URL input. */
  modifyReadImage?: boolean
  /** Allow non-Codex vision models to call imagegen. */
  shareImagegenWithOtherModels?: boolean
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean
}

export const Config: z<Config> = z.object({
  searchModel: z.string().default(DEFAULT_OPENAI_CODEX_SEARCH_MODEL),
  searchMode: z.union(['cached', 'indexed', 'live'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_MODE),
  searchContextSize: z.union(['low', 'medium', 'high'] as const).default(DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE),
  searchMaxOutputTokens: z.number().step(1).min(1).default(DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS),
  modifyReadImage: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
  useWebSocketContextReuse: z.boolean().default(false),
  useNativeCompaction: z.boolean().default(false),
})

/**
 * Register collision-free Provider routes and the standalone Codex search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
export function apply(ctx: Context, config: Config): void {
  assertCurrentPiXaiImageCatalog()
  installOpenAICodexSearchEvent()
  const service = new OpenAICodexService({
    modifyReadImage: config.modifyReadImage ?? true,
    shareImagegenWithOtherModels: config.shareImagegenWithOtherModels ?? true,
    useWebSocketContextReuse: config.useWebSocketContextReuse ?? false,
    useNativeCompaction: config.useNativeCompaction ?? false,
  })
  const proxy = installProviderProxy(provider => service.policy.providerVlessSnapshot(provider).useVless)
  service.attachProxy(proxy)
  ctx.effect(() => () => { proxy.dispose() }, 'dsh-providers: selective VLESS proxy')
  const credentials = service.credentials
  const imageTools = service.policy
  const modelSettings = service.modelSettings
  for (const [route, provider] of [[OPENAI_CODEX_PROVIDER, openaiCodexProvider()], [XAI_PROVIDER, xaiProvider()]] as const) {
    modelSettings.registerCatalog(route, async () => provider.getModels().map(model => ({
      id: model.id, name: model.name,
      defaultContextWindow: model.contextWindow, defaultMaxTokens: model.maxTokens,
    })))
  }
  ctx.provide('openAICodex', service)
  ctx.inject(['storageDomain'], async settingsCtx => { await service.attachSettings(settingsCtx) })

  /** Keep an OAuth-only route absent from the chat model picker until configured. */
  const registerWhenAuthenticated = (
    provider: typeof OPENAI_CODEX_PROVIDER | typeof XAI_PROVIDER,
    adapter: LlmAdapter,
    store: OpenAICodexCredentialStore,
  ): void => {
    let registration: AdapterRegistrationHandle | undefined
    let visible = false
    let disposed = false
    let stateVersion = 0
    const update = (authenticated: boolean): void => {
      if (disposed || authenticated === visible) return
      try {
        if (registration === undefined) {
          if (!authenticated) return
          registration = ctx.llm.registerAdapter([provider], adapter)
        } else {
          registration.replace(authenticated ? [provider] : [])
        }
        visible = authenticated
      } catch (error: unknown) {
        ctx.logger.warn(`could not ${authenticated ? 'show' : 'hide'} ${provider} models (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const stop = store.onStateChange(authenticated => {
      stateVersion += 1
      update(authenticated)
    })
    const initialVersion = stateVersion
    const stopModels = modelSettings.watch(() => {
      if (!disposed && visible) registration?.replace([provider])
    })
    void store.read(provider).then(
      credential => {
        if (stateVersion === initialVersion) update(credential?.type === 'oauth')
      },
      error => { ctx.logger.warn(`could not read ${provider} OAuth state (${error instanceof Error ? error.message : String(error)})`) },
    )
    ctx.effect(() => () => {
      disposed = true
      stop()
      stopModels()
    }, `${provider}: authenticated model visibility`)
  }

  registerWhenAuthenticated(
    OPENAI_CODEX_PROVIDER,
    new ConfigurableProviderAdapter(createOpenAICodexAdapter(
      credentials,
      () => ctx.get('attachments'),
      () => imageTools.responseApiSnapshot(),
      modelSettings,
    ), modelSettings),
    credentials,
  )
  registerWhenAuthenticated(
    XAI_PROVIDER,
    new ConfigurableProviderAdapter(createXaiAdapter(service.xaiCredentials, () => ctx.get('attachments'), modelSettings), modelSettings),
    service.xaiCredentials,
  )

  let googleRegistration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
  let googleAuthenticated = false
  const google = createGeminiService(ctx, {
    createClient: createRoutedGeminiOAuthClient,
    onAuthStateChange: authenticated => {
      googleAuthenticated = authenticated
      if (googleRegistration === undefined) {
        if (authenticated) {
          googleRegistration = ctx.llm.registerAdapter(
            [GOOGLE_OAUTH_PROVIDER],
            new ConfigurableProviderAdapter(new ProviderGoogleAdapter(google) as unknown as LlmAdapter, modelSettings),
          )
        }
        return
      }
      googleRegistration.replace(authenticated ? [GOOGLE_OAUTH_PROVIDER] : [])
    },
  })
  modelSettings.registerCatalog(GOOGLE_OAUTH_PROVIDER, async () => {
    const adapter = new ProviderGoogleAdapter(google)
    return (await adapter.listModels(GOOGLE_OAUTH_PROVIDER)).map(model => ({ id: model.id, name: model.name }))
  })
  const stopGoogleModels = modelSettings.watch(() => {
    if (googleAuthenticated) googleRegistration?.replace([GOOGLE_OAUTH_PROVIDER])
  })
  ctx.effect(() => stopGoogleModels)
  service.attachGoogle(google)
  void google.initialize().catch(error => {
    ctx.logger.warn(`Google OAuth startup failed (${error instanceof Error ? error.message : String(error)})`)
  })
  ctx.effect(() => async () => { await google.dispose() }, 'dsh-providers: Google OAuth service')
  ctx.web.registerSearchProvider(new OpenAICodexSearchProvider({
    credentials,
    model: config.searchModel ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
    mode: config.searchMode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
    contextSize: config.searchContextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
    maxOutputTokens: config.searchMaxOutputTokens ?? DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
    resolveRequestId: () => String(ctx.get('agents')?.currentInitiator()?.session.id ?? randomUUID()),
    recordRequest: request => { recordOpenAICodexSearchRequest(ctx, request) },
  }))
  ctx.inject(['webServer'], webCtx => registerOpenAICodexAuthRoutes(webCtx, credentials, imageTools, service))
  ctx.inject(['tools', 'fs', 'attachments'], toolCtx => {
    toolCtx.tools.register(imagegenTool(toolCtx, credentials, service.xaiCredentials, imageTools))
  })
  ctx.inject(['tools', 'fs', 'attachments', 'agents'], toolCtx => {
    installReadImageEnhancement(toolCtx, imageTools)
  })
}
