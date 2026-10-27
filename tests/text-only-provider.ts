import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

export const TEXT_ONLY_PROVIDER = 'test-text-only'
export const TEXT_ONLY_MODEL = 'text-only'

/** A declared negative capability, independent of an upstream model retirement. */
export function registerTextOnlyProvider(ctx: Context): void {
  ctx.llm.registerAdapter([TEXT_ONLY_PROVIDER], new class extends LlmAdapter {
    override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
      return { provider, id, name: 'Text-only fixture', inputModalities: ['text'] }
    }
    override async *stream(): AsyncIterable<StreamChunk> {
      throw new Error('The image capability check must refuse before model dispatch')
    }
  }())
}
