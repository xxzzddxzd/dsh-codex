/** Provider routes exposed by the bundled Provider settings surface. */

/** pi-ai's ChatGPT subscription route. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'
/** pi-ai's SuperGrok/X Premium subscription route. */
export const XAI_PROVIDER = 'xai'
/** Google Code Assist route supplied by @kelvinwww/dsh-oauth. */
export const GOOGLE_OAUTH_PROVIDER = 'gemini-cli-oauth'

/** Every provider whose network exit can be selected independently. */
export const MANAGED_PROVIDERS = [
  OPENAI_CODEX_PROVIDER,
  XAI_PROVIDER,
  GOOGLE_OAUTH_PROVIDER,
] as const

export type ManagedProvider = typeof MANAGED_PROVIDERS[number]

/** Fail closed when a Host route receives an unknown provider id. */
export function isManagedProvider(value: unknown): value is ManagedProvider {
  return typeof value === 'string' && (MANAGED_PROVIDERS as readonly string[]).includes(value)
}
