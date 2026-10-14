/** Durable per-model display and capacity overrides for OAuth providers. */
import type { Context } from '@deepseek-ai/cordis'
import { ProviderPreferencesScope } from './preferences.ts'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import type { ManagedProvider } from './provider-ids.ts'

export interface ModelOverride { id: string; visible?: boolean; contextWindow?: number; maxTokens?: number }
interface Preferences { providers: Record<string, ModelOverride[]> }
export interface ModelSettingsRow extends ModelOverride {
  name: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
}
const schema: z<Preferences> = z.object({ providers: z.dict(z.array(z.object({
  id: z.string().required(), visible: z.boolean(),
  contextWindow: z.number().step(1).min(1), maxTokens: z.number().step(1).min(1),
}))).default({}) })

export class ProviderModelPreferences {
  private current: Preferences = { providers: {} }
  private scope: ProviderPreferencesScope<Preferences> | undefined
  private listeners = new Set<() => void>()
  private catalogs = new Map<ManagedProvider, () => Promise<ModelSettingsRow[]>>()
  get ready(): boolean { return this.scope !== undefined }
  async attach(ctx: Context): Promise<void> {
    const scope = await ProviderPreferencesScope.open(ctx, 'provider-models', schema, this.current)
    this.scope = scope
    this.current = scope.get()
    const stop = scope.watch(next => {
      this.current = next
      for (const listener of this.listeners) listener()
    })
    ctx.effect(() => () => { stop(); this.scope = undefined })
  }
  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot(provider: string): readonly ModelOverride[] { return this.current.providers[provider] ?? [] }
  registerCatalog(provider: ManagedProvider, catalog: () => Promise<ModelSettingsRow[]>): void { this.catalogs.set(provider, catalog) }
  async catalog(provider: ManagedProvider): Promise<ModelSettingsRow[]> {
    const catalog = this.catalogs.get(provider)
    if (!catalog) throw new Error('Provider model catalog is unavailable')
    const overrides = this.snapshot(provider)
    return (await catalog()).map(model => ({ ...model, ...overrides.find(entry => entry.id === model.id) }))
  }
  async update(provider: ManagedProvider, value: unknown): Promise<void> {
    if (!Array.isArray(value) || value.length > 500) throw new Error('models must be an array of at most 500 entries')
    const known = new Set((await this.catalog(provider)).map(model => model.id))
    const seen = new Set<string>()
    const models: ModelOverride[] = value.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid model entry')
      const model = raw as Record<string, unknown>
      if (Object.keys(model).some(key => !['id', 'visible', 'contextWindow', 'maxTokens'].includes(key))) throw new Error('Unknown model setting')
      if (typeof model.id !== 'string' || !known.has(model.id) || seen.has(model.id)) throw new Error('Unknown or duplicate model id')
      seen.add(model.id)
      if (model.visible !== undefined && typeof model.visible !== 'boolean') throw new Error('visible must be boolean')
      for (const key of ['contextWindow', 'maxTokens'] as const) {
        if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || (model[key] as number) <= 0)) throw new Error(`${key} must be a positive integer`)
      }
      return { ...model } as unknown as ModelOverride
    })
    if (!this.scope) throw new Error('Provider settings service is unavailable')
    await this.scope.update({ providers: { [provider]: models } })
  }
}

/** New profile identities preserve in-flight snapshots while applying new pi model metadata. */
export function modelProfiles(base: Map<string, ResolvedPiAiProviderProfile>, settings?: ProviderModelPreferences) {
  let previous = ''
  let result = base
  return (): Map<string, ResolvedPiAiProviderProfile> => {
    if (!settings) return base
    const signature = JSON.stringify([...base.keys()].map(provider => settings.snapshot(provider)))
    if (signature === previous) return result
    previous = signature
    result = new Map([...base].map(([provider, profile]) => {
      const overrides = settings.snapshot(provider)
      const piProvider = profile.piProvider
      if (piProvider === undefined) return [provider, profile]
      const models = piProvider.getModels().map(model => {
        const override = overrides.find(entry => entry.id === model.id)
        return { ...model,
          ...override?.contextWindow === undefined ? {} : { contextWindow: override.contextWindow },
          ...override?.maxTokens === undefined ? {} : { maxTokens: override.maxTokens },
        }
      })
      return [provider, { ...profile,
        piProvider: { ...piProvider, getModels: () => models },
        configuredMaxTokens: new Map(overrides.flatMap(model => model.maxTokens === undefined ? [] : [[model.id, model.maxTokens] as const])),
      }]
    }))
    return result
  }
}

/** Display filtering keeps hidden models usable by existing sessions. */
export class ConfigurableProviderAdapter extends LlmAdapter {
  constructor(private readonly base: LlmAdapter, private readonly settings: ProviderModelPreferences) { super() }
  override providerInfo(provider: string) { return this.base.providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.base.providerRetryPolicy(provider) }
  override async listModels(provider: string) {
    const overrides = this.settings.snapshot(provider)
    return (await this.base.listModels(provider)).filter(model => overrides.find(entry => entry.id === model.id)?.visible !== false)
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return (await this.prepareCall(provider, model, signal)).model
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const override = this.settings.snapshot(provider).find(entry => entry.id === model)
    // Kelvin's older adapter predates prepareCall; retain its transport contract.
    const prepared = typeof this.base.prepareCall === 'function'
      ? await this.base.prepareCall(provider, model, signal)
      : { model: await this.base.resolveModel(provider, model, signal), stream: (options: GenerateOptions) => this.base.stream(options) }
    return {
      model: { ...prepared.model,
        ...override?.contextWindow === undefined ? {} : { context: { contextWindow: override.contextWindow } },
        ...override?.maxTokens === undefined ? {} : { defaultMaxTokens: override.maxTokens },
      },
      stream: (options: GenerateOptions) => prepared.stream({ ...options,
        ...options.maxTokens === undefined && override?.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {},
      }),
    }
  }
  override async *stream(options: GenerateOptions) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
}
