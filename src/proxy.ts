/** Hostname-selective proxy routing for OpenAI Codex network traffic. */

import { getGlobalDispatcher, ProxyAgent, request, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'

export interface OpenAICodexProxyHandle {
  /** Warm the production proxy pool, then measure a second request through it. */
  speedTest(): Promise<number>
  dispose(): void
}

/** Domains owned by the OpenAI surfaces used by OAuth, Codex, images, and assets. */
const OPENAI_PROXY_DOMAINS = [
  'openai.com',
  'chatgpt.com',
  'oaistatic.com',
  'oaiusercontent.com',
] as const

/** Match only an exact OpenAI domain or one of its subdomains. */
export function isOpenAIProxyHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  return OPENAI_PROXY_DOMAINS.some(domain => normalized === domain || normalized.endsWith(`.${domain}`))
}

/**
 * Compose a dispatcher that dynamically selects the loopback proxy for
 * OpenAI-owned hosts and preserves the existing dispatcher for everything else.
 */
export function createOpenAICodexDispatcher(
  direct: Dispatcher,
  proxied: Dispatcher,
  enabled: () => boolean,
): Dispatcher {
  return direct.compose(directDispatch => function dispatch(options, handler) {
    let hostname = ''
    try {
      if (options.origin !== undefined) hostname = new URL(options.origin).hostname
    } catch {
      // Let the original dispatcher report malformed request options.
    }
    return enabled() && isOpenAIProxyHost(hostname)
      ? proxied.dispatch(options, handler)
      : directDispatch(options, handler)
  })
}

/** Keep the first probe as warm-up and report only the reused connection. */
export async function measureWarmLatency(probe: () => Promise<number>): Promise<number> {
  await probe()
  return probe()
}

/**
 * Install one process-wide router because pi-ai uses the global fetch. Only
 * OpenAI hosts can reach the loopback proxy; DeepSeek and arbitrary tool URLs
 * continue through the process' original dispatcher.
 */
export function installOpenAICodexProxy(
  enabled: () => boolean,
  proxyUrl = 'http://127.0.0.1:18080',
): OpenAICodexProxyHandle {
  const parsed = new URL(proxyUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The OpenAI Codex loopback proxy must use http:// or https://')
  }
  const direct = getGlobalDispatcher()
  const proxied = new ProxyAgent(proxyUrl)
  const selective = createOpenAICodexDispatcher(direct, proxied, enabled)
  setGlobalDispatcher(selective)
  const probe = async (): Promise<number> => {
    const startedAt = performance.now()
    const response = await request('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      dispatcher: proxied,
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'dsh-codex-vless-speed-test' },
    })
    await response.body.dump()
    return Math.max(1, Math.round(performance.now() - startedAt))
  }
  return {
    speedTest: () => measureWarmLatency(probe),
    dispose: () => {
      if (getGlobalDispatcher() === selective) setGlobalDispatcher(direct)
      void proxied.close().catch(() => undefined)
    },
  }
}
