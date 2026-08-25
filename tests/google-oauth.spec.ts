import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { GeminiCliAdapter } from '@kelvinwww/dsh-oauth/gemini'
import type { GeminiTransport } from '@kelvinwww/dsh-oauth/gemini'
import { createRoutedGeminiOAuthClient } from '../src/google-oauth.ts'

describe('@kelvinwww/dsh-oauth Google transport', () => {
  it('uses native fetch so the shared provider dispatcher controls every request', () => {
    const client = createRoutedGeminiOAuthClient('client-id', 'client-secret')
    expect(client.transporter.defaults.fetchImplementation).toBe(globalThis.fetch)
  })

  it('registers the Kelvin Gemini adapter on the DSH 0.1.1-rc.2 LLM seam', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const transport = {
      listModels: () => Promise.resolve(['gemini-2.5-pro']),
    } as unknown as GeminiTransport
    ctx.llm.registerAdapter(
      ['gemini-cli-oauth'],
      new GeminiCliAdapter(transport) as unknown as LlmAdapter,
    )
    expect(ctx.llm.listProviders()).toEqual([{ id: 'gemini-cli-oauth', name: 'gemini-cli-oauth' }])
    await expect(ctx.llm.listModels('gemini-cli-oauth')).resolves.toEqual([
      { provider: 'gemini-cli-oauth', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ])
    await ctx.fiber.dispose()
  })
})
