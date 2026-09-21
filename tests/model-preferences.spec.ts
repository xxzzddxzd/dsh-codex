import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createOpenAICodexAdapter, createXaiAdapter } from '../src/adapter.ts'
import { ProviderModelPreferences, ConfigurableProviderAdapter } from '../src/model-preferences.ts'
import { OpenAICodexCredentialStore, XaiCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_PROVIDER as CODEX, XAI_PROVIDER as XAI } from '../src/provider-ids.ts'
import { GOOGLE_OAUTH_PROVIDER as GOOGLE } from '../src/provider-ids.ts'
import { ProviderGoogleAdapter } from '../src/google-oauth.ts'
import type { GeminiTransport } from '@kelvinwww/dsh-oauth/gemini'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

let stored: Record<string, unknown> = {}
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected async load() { return structuredClone(stored) }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) {
    stored = { ...stored, [String(ns)]: structuredClone(section) }
    this.publish(stored)
  }
}
let ctx: Context | undefined
async function setup() {
  ctx = new Context()
  await ctx.plugin(MemorySettings)
  const settings = new ProviderModelPreferences()
  settings.attach(ctx)
  settings.registerCatalog(CODEX, async () => [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', defaultContextWindow: 272000, defaultMaxTokens: 128000 }])
  settings.registerCatalog(XAI, async () => [{ id: 'grok-4.6', name: 'Grok 4.6' }])
  return settings
}
afterEach(async () => { await ctx?.fiber.dispose(); stored = {} })

describe('Provider model preferences', () => {
  it('sends the frozen Google output limit in the actual transport payload', async () => {
    const settings = await setup()
    settings.registerCatalog(GOOGLE, async () => [{ id: 'gemini-2.5-pro', name: 'Gemini' }])
    let body: string | undefined
    const transport = {
      getProjectId: async () => 'test-project',
      requestStream: async (request: { body: string }) => { body = request.body; throw new Error('stop-before-network') },
    } as unknown as GeminiTransport
    const adapter = new ConfigurableProviderAdapter(new ProviderGoogleAdapter(transport) as unknown as LlmAdapter, settings)
    await settings.update(GOOGLE, [{ id: 'gemini-2.5-pro', contextWindow: 1000000, maxTokens: 1234 }])
    const prepared = await adapter.prepareCall(GOOGLE, 'gemini-2.5-pro')
    await settings.update(GOOGLE, [])
    const iterator = prepared.stream({ provider: GOOGLE, model: 'gemini-2.5-pro', messages: [], signal: new AbortController().signal })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('stop-before-network')
    expect(JSON.parse(body!).request.generationConfig.maxOutputTokens).toBe(1234)
    expect(prepared.model.context?.contextWindow).toBe(1000000)
  })
  it('persists per-provider edits, hides only discovery, freezes prepared capacity, and restores defaults', async () => {
    const settings = await setup()
    const base = createOpenAICodexAdapter(new OpenAICodexCredentialStore('/tmp/unused-provider-model-test-auth'), () => undefined,
      () => ({ useNativeCompaction: false, useWebSocketContextReuse: false }), settings)
    const adapter = new ConfigurableProviderAdapter(base, settings)
    const before = await adapter.prepareCall(CODEX, 'gpt-6-astra')
    await settings.update(CODEX, [{ id: 'gpt-6-astra', visible: false, contextWindow: 1000000, maxTokens: 8000 }])
    await settings.update(XAI, [{ id: 'grok-4.6', maxTokens: 4000 }])
    expect((await adapter.listModels(CODEX)).some(model => model.id === 'gpt-6-astra')).toBe(false)
    expect(await adapter.resolveModel(CODEX, 'gpt-6-astra')).toMatchObject({ context: { contextWindow: 1000000 }, defaultMaxTokens: 8000 })
    expect(await base.resolveModel(CODEX, 'gpt-6-astra')).toMatchObject({ context: { contextWindow: 1000000 }, defaultMaxTokens: 8000 })
    expect(before.model.context?.contextWindow).toBe(272000)
    await ctx!.fiber.dispose()
    const restored = await setup()
    expect(restored.snapshot(CODEX)[0]).toMatchObject({ visible: false, contextWindow: 1000000 })
    expect(restored.snapshot(XAI)[0]).toMatchObject({ maxTokens: 4000 })
    await restored.update(CODEX, [])
    expect(restored.snapshot(CODEX)).toEqual([])
    expect(restored.snapshot(XAI)[0]).toMatchObject({ maxTokens: 4000 })
  })

  it('propagates the xAI output default into a prepared call and refuses invalid edits', async () => {
    const settings = await setup()
    const adapter = createXaiAdapter(new XaiCredentialStore('/tmp/unused-provider-model-test-xai'), () => undefined, settings)
    await settings.update(XAI, [{ id: 'grok-4.6', contextWindow: 300000, maxTokens: 5000 }])
    expect((await adapter.prepareCall(XAI, 'grok-4.6')).model).toMatchObject({ context: { contextWindow: 300000 }, defaultMaxTokens: 5000 })
    for (const entry of [{ id: 'missing' }, { id: 'grok-4.6', maxTokens: -1 }, { id: 'grok-4.6', contextWindow: 1.5 }, { id: 'grok-4.6', visible: 'false' }]) {
      await expect(settings.update(XAI, [entry])).rejects.toThrow()
    }
    await settings.update(XAI, [{ id: 'grok-4.6' }])
    expect((await adapter.resolveModel(XAI, 'grok-4.6')).context?.contextWindow).toBe(500000)
  })
})
