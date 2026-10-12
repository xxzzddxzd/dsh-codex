import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GeminiTransport } from '@kelvinwww/dsh-oauth/gemini'
import { createRoutedGeminiOAuthClient, ProviderGoogleAdapter } from '../src/google-oauth.ts'
import { GOOGLE_OAUTH_PROVIDER } from '../src/provider-ids.ts'
import { ConfigurableProviderAdapter, ProviderModelPreferences } from '../src/model-preferences.ts'

describe('@kelvinwww/dsh-oauth Google transport', () => {
  it('uses native fetch so the shared provider dispatcher controls every request', () => {
    const client = createRoutedGeminiOAuthClient('client-id', 'client-secret')
    expect(client.transporter.defaults.fetchImplementation).toBe(globalThis.fetch)
  })

  it('registers the Kelvin Gemini adapter on the DSH 0.2.0 LLM seam', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const transport = {
      listModels: () => Promise.resolve(['gemini-2.5-pro']),
    } as unknown as GeminiTransport
    ctx.llm.registerAdapter(
      [GOOGLE_OAUTH_PROVIDER],
      new ConfigurableProviderAdapter(new ProviderGoogleAdapter(transport) as unknown as LlmAdapter, new ProviderModelPreferences()),
    )
    expect(ctx.llm.listProviders()).toEqual([{ id: GOOGLE_OAUTH_PROVIDER, name: 'Provider Google OAuth' }])
    await expect(ctx.llm.listModels(GOOGLE_OAUTH_PROVIDER)).resolves.toEqual([
      { provider: GOOGLE_OAUTH_PROVIDER, id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ])
    await ctx.fiber.dispose()
  })
})
