/** Provider routes exposed by the bundled Provider settings surface. */

/** ChatGPT subscription route owned by the Provider settings bundle. */
export const OPENAI_CODEX_PROVIDER = 'provider-codex'
/** SuperGrok/X Premium subscription route owned by the Provider settings bundle. */
export const XAI_PROVIDER = 'provider-xai'
/** Google Code Assist route owned by the Provider settings bundle. */
export const GOOGLE_OAUTH_PROVIDER = 'provider-google'

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
