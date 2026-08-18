import { describe, expect, it } from 'vitest'
import { Dispatcher } from 'undici'
import type { Dispatcher as DispatcherType } from 'undici'
import { createOpenAICodexDispatcher, isOpenAIProxyHost, measureWarmLatency } from '../src/proxy.ts'

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
})
