/** Request model identifiers accepted by the Codex subscription image endpoint.
 * The endpoint does not report the actual model and may ignore this selection. */
export const CODEX_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const
export type CodexImageModel = typeof CODEX_IMAGE_MODELS[number]
export const DEFAULT_CODEX_IMAGE_MODEL: CodexImageModel = 'gpt-image-2'
export function isCodexImageModel(value: unknown): value is CodexImageModel {
  return typeof value === 'string' && (CODEX_IMAGE_MODELS as readonly string[]).includes(value)
}
