import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('OpenAI Codex real composition', () => {
  it('loads through the Loader, exposes the catalog, and unregisters on disposal', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-loader-'))
    vi.stubEnv('DSH_HOME', root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: web',
      "  name: 'test-web-service'",
      '- id: llm-openai-codex',
      '  name: dsh-codex',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['test-web-service', WebRuntime],
      ['dsh-codex', OpenAICodex],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    await vi.waitFor(() => { expect(ctx.llm.listProviders()).toEqual([]) })

    const credential = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }
    await ctx.openAICodex.credentials.modify(
      OpenAICodex.OPENAI_CODEX_PROVIDER,
      () => Promise.resolve({ ...credential, accountId: 'account-1' }),
    )
    await ctx.openAICodex.xaiCredentials.modify(
      OpenAICodex.XAI_PROVIDER,
      () => Promise.resolve(credential),
    )
    expect(ctx.llm.listProviders()).toEqual([
      { id: OpenAICodex.OPENAI_CODEX_PROVIDER, name: 'Provider Codex' },
      { id: OpenAICodex.XAI_PROVIDER, name: 'Provider xAI' },
    ])
    const models = await ctx.llm.listModels(OpenAICodex.OPENAI_CODEX_PROVIDER)
    expect(models.some(model => model.id === 'gpt-5.6-sol')).toBe(true)
    expect(models).toContainEqual(expect.objectContaining({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      provider: OpenAICodex.OPENAI_CODEX_PROVIDER,
    }))
    const xaiModels = await ctx.llm.listModels(OpenAICodex.XAI_PROVIDER)
    expect(xaiModels.map(model => model.id)).toContain('grok-4.6')

    const modelsPageXai = {
      providerInfo: (provider: string) => ({ id: provider, name: 'xAI' }),
      providerRetryPolicy: () => undefined,
      listModels: (provider: string) => Promise.resolve([
        { provider, id: 'grok-4.6', name: 'Grok 4.6' },
      ]),
    } as unknown as LlmAdapter
    const nativeXaiRegistration = ctx.llm.registerAdapter(['xai'], modelsPageXai)
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'xai', name: 'xAI' })
    await expect(ctx.llm.listModels('xai')).resolves.toEqual([
      { provider: 'xai', id: 'grok-4.6', name: 'Grok 4.6' },
    ])

    await ctx.openAICodex.xaiCredentials.delete(OpenAICodex.XAI_PROVIDER)
    expect(ctx.llm.listProviders()).not.toContainEqual({ id: OpenAICodex.XAI_PROVIDER, name: 'Provider xAI' })
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'xai', name: 'xAI' })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'dsh-codex')
    if (entry === undefined) throw new Error('OpenAI Codex Loader entry missing')
    if (entry.fiber === undefined) throw new Error('OpenAI Codex plugin fiber missing')
    await entry.fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'xai', name: 'xAI' }])
    nativeXaiRegistration()
  })
})
