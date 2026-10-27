import { describe, expect, it } from 'vitest'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { describeProviderComponents } from '../src/components.ts'
import { routedProvider } from '../src/routed-provider.ts'
import { assertCurrentPiXaiImageCatalog } from '../src/xai-images.ts'

describe('Provider components and unified model catalogs', () => {
  it('reports the resolved pi-ai version and GPT-6.1 Sol from the actual catalog', () => {
    const info = describeProviderComponents()
    expect(info.bundle.version).toBe('0.2.11')
    expect(info.piAi.version).toBe('1.4.0')
    expect(info.piAi.version).toBe(info.piAi.declaredVersion)
    expect(info.catalogs['provider-codex']).toContain('gpt-6.1-sol')
    expect(info.catalogs['provider-codex']).not.toContain('gpt-5.3-codex-spark')
    expect(info.catalogs['provider-codex']).not.toContain('gpt-5.5')
  })
  it('keeps unified image and chat model identities under the aliased route', () => {
    const routed = routedProvider(openrouterProvider(), 'test-router', 'Test')
    const models = routed.getAllModels?.() ?? []
    expect(models.some(model => model.type === 'chat')).toBe(true)
    expect(models.some(model => model.type === 'image')).toBe(true)
    expect(models.every(model => model.provider === 'test-router')).toBe(true)
    expect(routed.getModels().every(model => model.type === 'chat')).toBe(true)
  })
  it('retains the supported xAI image catalog through the unified API', () => {
    expect(() => assertCurrentPiXaiImageCatalog()).not.toThrow()
    expect(describeProviderComponents().xaiImageModels).toEqual(['grok-imagine-image-2.0', 'grok-imagine-image-quality'])
  })
})
