/** Versions and static model catalogs of the loaded Provider bundle. */
import { readFileSync } from 'node:fs'
import metadata from '../package.json' with { type: 'json' }
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { XAI_IMAGE_MODELS } from './xai-images.ts'
import { OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from './provider-ids.ts'

const resolvedPiPackage = JSON.parse(readFileSync(new URL('../../package.json',
  import.meta.resolve('@earendil-works/pi-ai/providers/openai-codex')), 'utf8')) as { name: string; version: string }

/** Public metadata only: no account, credential, prompt, or user preference data. */
export function describeProviderComponents() {
  return {
    schema: 1,
    bundle: { name: metadata.name, version: metadata.version },
    piAi: { name: resolvedPiPackage.name, version: resolvedPiPackage.version,
      declaredVersion: metadata.dependencies['@earendil-works/pi-ai'] },
    catalogs: {
      [OPENAI_CODEX_PROVIDER]: openaiCodexProvider().getModels().map(model => model.id),
      [XAI_PROVIDER]: xaiProvider().getModels().map(model => model.id),
    },
    xaiImageModels: [...XAI_IMAGE_MODELS],
  }
}
