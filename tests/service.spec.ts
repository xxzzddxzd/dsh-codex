import { describe, expect, it, vi } from 'vitest'
import { OpenAICodexService } from '../src/service.ts'
import { GOOGLE_OAUTH_PROVIDER, XAI_PROVIDER } from '../src/provider-ids.ts'

function service(): OpenAICodexService {
  return new OpenAICodexService({
    modifyReadImage: true,
    shareImagegenWithOtherModels: true,
    useWebSocketContextReuse: false,
    useNativeCompaction: false,
  })
}

describe('OpenAICodexService network exit', () => {
  it('reports whether the Google OAuth installed-app client is configured', () => {
    vi.stubEnv('GEMINI_CLIENT_ID', '')
    vi.stubEnv('GEMINI_CLIENT_SECRET', '')
    expect(service().googleOAuthConfigured()).toBe(false)

    vi.stubEnv('GEMINI_CLIENT_ID', 'client-id')
    vi.stubEnv('GEMINI_CLIENT_SECRET', 'client-secret')
    expect(service().googleOAuthConfigured()).toBe(true)
    vi.unstubAllEnvs()
  })

  it('projects the legacy durable switch as a provider-facing exit', async () => {
    const subject = service()
    vi.spyOn(subject.vless, 'status').mockResolvedValue({
      configured: true,
      running: true,
      reachable: true,
      node: 'home',
    })
    vi.spyOn(subject.policy, 'vlessSnapshot').mockReturnValue({ useVless: false })

    await expect(subject.vlessStatus()).resolves.toMatchObject({
      enabled: false,
      egress: 'direct',
      node: 'home',
    })

    vi.mocked(subject.policy.vlessSnapshot).mockReturnValue({ useVless: true })
    await expect(subject.vlessStatus()).resolves.toMatchObject({
      enabled: true,
      egress: 'vless',
    })
  })

  it('checks VLESS readiness only when that exit is selected', async () => {
    const subject = service()
    let useVless = false
    const ready = vi.spyOn(subject.vless, 'ensureReady').mockResolvedValue(undefined)
    vi.spyOn(subject.vless, 'status').mockResolvedValue({
      configured: true,
      running: true,
      reachable: true,
    })
    vi.spyOn(subject.policy, 'vlessSnapshot').mockImplementation(() => ({ useVless }))
    vi.spyOn(subject.policy, 'updateVless').mockImplementation(async next => {
      useVless = next
      return { useVless }
    })

    await expect(subject.updateEgress('vless')).resolves.toMatchObject({ egress: 'vless' })
    expect(ready).toHaveBeenCalledTimes(1)

    await expect(subject.updateEgress('direct')).resolves.toMatchObject({ egress: 'direct' })
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('persists independent xAI and Google exits against the shared VLESS client', async () => {
    const subject = service()
    const selected = new Map([[XAI_PROVIDER, false], [GOOGLE_OAUTH_PROVIDER, false]])
    const ready = vi.spyOn(subject.vless, 'ensureReady').mockResolvedValue(undefined)
    vi.spyOn(subject.vless, 'status').mockResolvedValue({ configured: true, running: true, reachable: true })
    vi.spyOn(subject.policy, 'providerVlessSnapshot').mockImplementation(provider => ({
      useVless: selected.get(provider as typeof XAI_PROVIDER | typeof GOOGLE_OAUTH_PROVIDER) ?? false,
    }))
    vi.spyOn(subject.policy, 'updateProviderVless').mockImplementation(async (provider, enabled) => {
      selected.set(provider as typeof XAI_PROVIDER | typeof GOOGLE_OAUTH_PROVIDER, enabled)
      return { useVless: enabled }
    })

    await expect(subject.updateProviderEgress(XAI_PROVIDER, 'vless')).resolves.toMatchObject({ egress: 'vless' })
    await expect(subject.providerVlessStatus(GOOGLE_OAUTH_PROVIDER)).resolves.toMatchObject({ egress: 'direct' })
    await expect(subject.updateProviderEgress(GOOGLE_OAUTH_PROVIDER, 'vless')).resolves.toMatchObject({ egress: 'vless' })
    expect(ready).toHaveBeenCalledTimes(2)
  })
})
