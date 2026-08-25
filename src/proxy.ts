/** Hostname-selective VLESS routing for managed subscription providers. */

import { getGlobalDispatcher, ProxyAgent, request, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'
import {
  GOOGLE_OAUTH_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  XAI_PROVIDER,
} from './provider-ids.ts'
import type { ManagedProvider } from './provider-ids.ts'

export interface ProviderProxyHandle {
  /** Warm the production proxy pool, then measure a second request through it. */
  speedTest(): Promise<number>
  dispose(): void
}

/** Backward-compatible public name used by the existing Codex service. */
export type OpenAICodexProxyHandle = ProviderProxyHandle

const PROVIDER_PROXY_DOMAINS: Readonly<Record<ManagedProvider, readonly string[]>> = {
  [OPENAI_CODEX_PROVIDER]: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'],
  [XAI_PROVIDER]: ['x.ai'],
  [GOOGLE_OAUTH_PROVIDER]: ['googleapis.com', 'google.com', 'gstatic.com', 'googleusercontent.com'],
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, '')
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/** Match a provider's exact service domains and their subdomains. */
export function isProviderProxyHost(provider: ManagedProvider, hostname: string): boolean {
  const normalized = normalizedHostname(hostname)
  return PROVIDER_PROXY_DOMAINS[provider].some(domain => domainMatches(normalized, domain))
}

/** Preserve the established OpenAI-only hostname predicate for API consumers. */
export function isOpenAIProxyHost(hostname: string): boolean {
  return isProviderProxyHost(OPENAI_CODEX_PROVIDER, hostname)
}

function providerForHost(hostname: string): ManagedProvider | undefined {
  if (isProviderProxyHost(OPENAI_CODEX_PROVIDER, hostname)) return OPENAI_CODEX_PROVIDER
  if (isProviderProxyHost(XAI_PROVIDER, hostname)) return XAI_PROVIDER
  if (isProviderProxyHost(GOOGLE_OAUTH_PROVIDER, hostname)) return GOOGLE_OAUTH_PROVIDER
  return undefined
}

/** Compose a dispatcher that chooses VLESS independently for each provider. */
export function createProviderDispatcher(
  direct: Dispatcher,
  proxied: Dispatcher,
  enabled: (provider: ManagedProvider) => boolean,
): Dispatcher {
  return direct.compose(directDispatch => function dispatch(options, handler) {
    let hostname = ''
    try {
      if (options.origin !== undefined) hostname = new URL(options.origin).hostname
    } catch {
      // Let the original dispatcher report malformed request options.
    }
    const provider = providerForHost(hostname)
    return provider !== undefined && enabled(provider)
      ? proxied.dispatch(options, handler)
      : directDispatch(options, handler)
  })
}

/** Backward-compatible OpenAI-only dispatcher constructor. */
export function createOpenAICodexDispatcher(
  direct: Dispatcher,
  proxied: Dispatcher,
  enabled: () => boolean,
): Dispatcher {
  return createProviderDispatcher(direct, proxied, provider => provider === OPENAI_CODEX_PROVIDER && enabled())
}

/** Keep the first probe as warm-up and report only the reused connection. */
export async function measureWarmLatency(probe: () => Promise<number>): Promise<number> {
  await probe()
  return probe()
}

/** Install one process-wide dispatcher with independent provider switches. */
export function installProviderProxy(
  enabled: (provider: ManagedProvider) => boolean,
  proxyUrl = 'http://127.0.0.1:18080',
): ProviderProxyHandle {
  const parsed = new URL(proxyUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The provider loopback proxy must use http:// or https://')
  }
  const direct = getGlobalDispatcher()
  const proxied = new ProxyAgent(proxyUrl)
  const selective = createProviderDispatcher(direct, proxied, enabled)
  setGlobalDispatcher(selective)
  const probe = async (): Promise<number> => {
    const startedAt = performance.now()
    const response = await request('https://www.gstatic.com/generate_204', {
      method: 'GET',
      dispatcher: proxied,
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'dsh-provider-vless-speed-test' },
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

/** Preserve the old installer as an OpenAI-only convenience wrapper. */
export function installOpenAICodexProxy(
  enabled: () => boolean,
  proxyUrl = 'http://127.0.0.1:18080',
): OpenAICodexProxyHandle {
  return installProviderProxy(provider => provider === OPENAI_CODEX_PROVIDER && enabled(), proxyUrl)
}
