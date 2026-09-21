/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthContext, MutableModels, Provider } from '@earendil-works/pi-ai'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import type { XaiCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from './store.ts'
import { routedProvider } from './routed-provider.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ResponseApiPreferences } from './tool-policy.ts'
import { modelProfiles } from './model-preferences.ts'
import type { ProviderModelPreferences } from './model-preferences.ts'

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Keep the route aligned with dsh-llm-pi-ai's documented request-image defaults. */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Ambient auth lookups used when pi-ai resolves a provider-native credential. */
const authContext: AuthContext = {
  async env(name) {
    return process.env[name]
  },
  async fileExists(filename) {
    const expanded = filename === '~' || filename.startsWith('~/')
      ? resolve(homedir(), filename.slice(1).replace(/^\//, ''))
      : filename
    try {
      await access(expanded)
      return true
    } catch {
      return false
    }
  },
}

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function requestProvider(provider: Provider): Provider {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/**
 * DSH and this plugin load pi-ai from separate package instances even when
 * their versions match. Static providers have no refresh hook, so this keeps
 * that package boundary explicit and local.
 */
function adapterProvider(
  provider: Provider,
): NonNullable<ResolvedPiAiProviderProfile['piProvider']> {
  if (provider.refreshModels !== undefined) {
    throw new Error(`dynamic pi-ai provider "${provider.id}" cannot be mounted through the DSH adapter`)
  }
  return provider as unknown as NonNullable<ResolvedPiAiProviderProfile['piProvider']>
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
  ) {
    super(options)
  }

  private async *trackedStream(
    options: GenerateOptions,
    source: AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    try {
      for await (const chunk of source) yield chunk
    } finally {
      release?.()
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.trackedStream(options, super.stream(options))
  }

  override async prepareCall(...args: Parameters<PiAiAdapter['prepareCall']>) {
    const prepared = await super.prepareCall(...args)
    return {
      ...prepared,
      stream: (options: GenerateOptions) => this.trackedStream(options, prepared.stream(options)),
    }
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
  modelSettings?: ProviderModelPreferences,
): PiAiAdapter {
  const provider = routedProvider(openaiCodexProvider(), OPENAI_CODEX_PROVIDER, 'Provider Codex')
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'Provider Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-openai-codex retryPolicy'),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    piProvider: adapterProvider(responses.wrap(requestProvider(provider))),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: modelProfiles(profiles, modelSettings),
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    auth: { credentials, authContext },
    resolveAttachments,
  }, responses)
}

/** Create the pi-ai xAI adapter using its native SuperGrok/X OAuth tokens. */
export function createXaiAdapter(
  credentials: XaiCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  modelSettings?: ProviderModelPreferences,
): PiAiAdapter {
  const provider = routedProvider(xaiProvider(), XAI_PROVIDER, 'Provider xAI')
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[XAI_PROVIDER, {
    provider: XAI_PROVIDER,
    displayName: 'Provider xAI',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-xai retryPolicy'),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    piProvider: adapterProvider(requestProvider(provider)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new PiAiAdapter({
    profiles: modelProfiles(profiles, modelSettings),
    resolveApiKey: async () => (await models.getAuth(XAI_PROVIDER))?.auth.apiKey,
    auth: { credentials, authContext },
    resolveAttachments,
  })
}
