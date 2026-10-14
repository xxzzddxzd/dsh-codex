/** xAI image models exposed by the pinned current pi-ai catalog. */

import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'

export const XAI_IMAGE_MODELS = [
  'grok-imagine-image-2.0',
  'grok-imagine-image-quality',
] as const

export type XaiImageModel = typeof XAI_IMAGE_MODELS[number]

export const DEFAULT_XAI_IMAGE_MODEL: XaiImageModel = 'grok-imagine-image-2.0'

/** Fail closed if the pinned pi catalog and the settings surface drift apart. */
export function assertCurrentPiXaiImageCatalog(): void {
  const actual = (openrouterProvider().getAllModels?.() ?? [])
    .filter(model => model.type === 'image')
    .map(model => model.id)
    .filter(id => id.startsWith('x-ai/'))
    .map(id => id.slice('x-ai/'.length))
    .sort()
  const expected = [...XAI_IMAGE_MODELS].sort()
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`pi-ai xAI image catalog changed: expected ${expected.join(', ')}, received ${actual.join(', ')}`)
  }
}

export function isXaiImageModel(value: unknown): value is XaiImageModel {
  return typeof value === 'string' && (XAI_IMAGE_MODELS as readonly string[]).includes(value)
}
