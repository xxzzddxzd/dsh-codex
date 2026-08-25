import { describe, expect, it } from 'vitest'
import { Dispatcher } from 'undici'
import type { Dispatcher as DispatcherType } from 'undici'
import {
  createOpenAICodexDispatcher,
  createProviderDispatcher,
  isOpenAIProxyHost,
  isProviderProxyHost,
  measureWarmLatency,
} from '../src/proxy.ts'
import { GOOGLE_OAUTH_PROVIDER, OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from '../src/provider-ids.ts'

class RecordingDispatcher extends Dispatcher {
  readonly origins: string[] = []

  dispatch(options: DispatcherType.DispatchOptions, _handler: DispatcherType.DispatchHandler): boolean {
    this.origins.push(String(options.origin))
    return true
  }
}

function send(dispatcher: DispatcherType, origin: string): void {
  dispatcher.dispatch({ origin, path: '/', method: 'GET' }, {} as DispatcherType.DispatchHandler)
}

describe('OpenAI-selective proxy dispatcher', () => {
  it('warms once and reports the reused request only', async () => {
    const results = [900, 120]
    let calls = 0

    expect(await measureWarmLatency(() => Promise.resolve(results[calls++] ?? 0))).toBe(120)
    expect(calls).toBe(2)
  })

  it('matches exact OpenAI domains and subdomains without suffix confusion', () => {
    expect(isOpenAIProxyHost('auth.openai.com')).toBe(true)
    expect(isOpenAIProxyHost('chatgpt.com')).toBe(true)
    expect(isOpenAIProxyHost('cdn.oaistatic.com')).toBe(true)
    expect(isOpenAIProxyHost('openai.com.evil.example')).toBe(false)
    expect(isOpenAIProxyHost('notopenai.com')).toBe(false)
  })

  it('recognizes xAI and Google service domains without cross-provider suffix matches', () => {
    expect(isProviderProxyHost(XAI_PROVIDER, 'api.x.ai')).toBe(true)
    expect(isProviderProxyHost(XAI_PROVIDER, 'x.ai.evil.example')).toBe(false)
    expect(isProviderProxyHost(GOOGLE_OAUTH_PROVIDER, 'oauth2.googleapis.com')).toBe(true)
    expect(isProviderProxyHost(GOOGLE_OAUTH_PROVIDER, 'cloudcode-pa.googleapis.com')).toBe(true)
    expect(isProviderProxyHost(GOOGLE_OAUTH_PROVIDER, 'googleapis.com.evil.example')).toBe(false)
  })

  it('routes dynamically while leaving DeepSeek and arbitrary URLs direct', () => {
    const direct = new RecordingDispatcher()
    const proxied = new RecordingDispatcher()
    let enabled = false
    const router = createOpenAICodexDispatcher(direct, proxied, () => enabled)

    send(router, 'https://api.openai.com')
    enabled = true
    send(router, 'https://auth.openai.com')
    send(router, 'https://chatgpt.com')
    send(router, 'https://api.deepseek.com')
    send(router, 'https://example.net')

    expect(proxied.origins).toEqual(['https://auth.openai.com', 'https://chatgpt.com'])
    expect(direct.origins).toEqual(['https://api.openai.com', 'https://api.deepseek.com', 'https://example.net'])
  })

  it('selects VLESS independently for all three managed providers', () => {
    const direct = new RecordingDispatcher()
    const proxied = new RecordingDispatcher()
    const enabled = new Set([XAI_PROVIDER, GOOGLE_OAUTH_PROVIDER])
    const router = createProviderDispatcher(direct, proxied, provider => enabled.has(provider))

    send(router, 'https://api.openai.com')
    send(router, 'https://api.x.ai')
    send(router, 'https://oauth2.googleapis.com')
    enabled.delete(XAI_PROVIDER)
    enabled.add(OPENAI_CODEX_PROVIDER)
    send(router, 'https://auth.x.ai')
    send(router, 'https://chatgpt.com')
    send(router, 'https://api.deepseek.com')

    expect(proxied.origins).toEqual([
      'https://api.x.ai',
      'https://oauth2.googleapis.com',
      'https://chatgpt.com',
    ])
    expect(direct.origins).toEqual([
      'https://api.openai.com',
      'https://auth.x.ai',
      'https://api.deepseek.com',
    ])
  })
})
