import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Provider from '../src/index.ts'
import { OpenAICodexWebAuth } from '../src/auth-routes.ts'
import { PROVIDER_SETTINGS_PATH } from '../src/native-panel.ts'

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('loads the Provider API through real Loader and Connection, fences owner access, and shares Web state across reload', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-provider-loader-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('GEMINI_CLIENT_ID', '')
  vi.stubEnv('GEMINI_CLIENT_SECRET', '')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request in native composition test') }))
  const routes = new Map<string, WebRoute>()
  const webServer = {
    register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path) } },
  } as unknown as WebServer
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', '  name: test-llm-service',
    '- id: web', '  name: test-web-service',
    '- id: llm-openai-codex', '  name: dsh-codex', '',
  ].join('\n'))
  const context = new Context()
  ctx = context
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime], ['test-web-service', WebRuntime], ['dsh-codex', Provider],
  ])
  context.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`Unexpected test import ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  expect(context.openAICodex.settingsReady).toBe(false)
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(root, 'storages') })
  await context.plugin(StorageDomain, { backend: 'json' })
  await vi.waitFor(() => { expect(context.openAICodex.settingsReady).toBe(true) })
  // The optional native route follows the actual Web and Connection services,
  // even when those services mount after the Provider Loader row.
  context.provide('webServer', webServer)
  const connection = new HostConnectionService(context, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  const carrier = connection.createSharedFetchHandler('/api')
  const owner = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  const guest = { principal: { kind: 'non-owner-test' } } as unknown as PeerScope
  const request = (action: string, payload: unknown = {}) => new Request('http://localhost' + PROVIDER_SETTINGS_PATH, {
    method: 'POST', body: JSON.stringify({ action, payload }),
  })
  const api = async (action: string, payload: unknown = {}) => (await carrier.fetch(request(action, payload), owner)).json()
  await vi.waitFor(async () => { expect(await api('overview')).toMatchObject({ ok: true, value: { settingsReady: true } }) })
  expect(carrier.requestBodyMode({ method: 'POST', url: new URL('http://localhost' + PROVIDER_SETTINGS_PATH) })).toBe('streaming')

  const denied = await carrier.fetch(request('images.set', { modifyReadImage: false }), guest)
  expect(denied.status).toBe(403)
  expect(context.openAICodex.imagePreferences().modifyReadImage).toBe(true)
  expect(await api('images.set', { modifyReadImage: false })).toMatchObject({ ok: true, value: { modifyReadImage: false } })
  expect(await api('responses.set', { useNativeCompaction: true })).toMatchObject({ ok: true })
  expect(await api('models.set', { provider: Provider.OPENAI_CODEX_PROVIDER,
    models: [{ id: 'gpt-6.1-sol', maxTokens: 8192, visible: false }] })).toMatchObject({ ok: true })

  async function webGet(path: string): Promise<unknown> {
    const route = routes.get(path)
    if (!route) throw new Error(`Missing Web route ${path}`)
    let status = 0, body = ''
    const request = { method: 'GET', headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
    const response = { writeHead(value: number) { status = value }, end(value: string) { body = value } } as unknown as ServerResponse
    await route.handler(request, response)
    expect(status).toBe(200)
    return JSON.parse(body)
  }
  expect(await webGet('/plugins/dsh-openai-codex/image-tools')).toMatchObject({ modifyReadImage: false })
  expect(await webGet('/plugins/dsh-openai-codex/response-api')).toMatchObject({ useNativeCompaction: true })
  expect(await webGet('/plugins/dsh-openai-codex/providers/provider-codex/models')).toMatchObject({
    models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol', maxTokens: 8192, visible: false })]),
  })
  const authOwners: unknown[] = []
  const statusSpy = vi.spyOn(OpenAICodexWebAuth.prototype, 'status').mockImplementation(function (this: OpenAICodexWebAuth) {
    authOwners.push(this)
    return Promise.resolve({ status: 'signing-in' })
  })
  expect(await api('auth.status', { provider: Provider.OPENAI_CODEX_PROVIDER })).toMatchObject({ ok: true, value: { status: 'signing-in' } })
  expect(await webGet('/plugins/dsh-openai-codex/auth/status')).toEqual({ status: 'signing-in' })
  expect(authOwners).toHaveLength(2)
  expect(authOwners[0]).toBe(authOwners[1])
  statusSpy.mockRestore()

  const entry = [...context.loader.entries()].find(row => row.options.name === 'dsh-codex')
  if (!entry?.fiber) throw new Error('Provider Loader row unavailable')
  await entry.fiber.dispose()
  await vi.waitFor(async () => { expect((await carrier.fetch(request('overview'), owner)).status).toBe(404) })
  expect(routes.has('/plugins/dsh-openai-codex/image-tools')).toBe(false)
  await context.loader.create({ name: 'dsh-codex' })
  await context.loader.await()
  await vi.waitFor(async () => { expect(await api('images.get')).toMatchObject({ ok: true, value: { modifyReadImage: false } }) })
  expect(await api('responses.get')).toMatchObject({ ok: true, value: { useNativeCompaction: true } })
  expect(await api('models.get', { provider: Provider.OPENAI_CODEX_PROVIDER })).toMatchObject({
    ok: true, value: { models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol', maxTokens: 8192, visible: false })]) },
  })
  expect(fetch).not.toHaveBeenCalled()
})
