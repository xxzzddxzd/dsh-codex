/** Google Code Assist integration sourced from @kelvinwww/dsh-oauth. */

import { createGeminiOAuthClient, GeminiCliAdapter } from '@kelvinwww/dsh-oauth/gemini'
import { GOOGLE_OAUTH_PROVIDER } from './provider-ids.ts'

/** Route expected internally by the third-party adapter. */
const KELVIN_GOOGLE_PROVIDER = 'gemini-cli-oauth'

/** Expose Kelvin's fixed adapter through the collision-free Provider route. */
export class ProviderGoogleAdapter extends GeminiCliAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Provider Google OAuth' }
  }

  override async listModels(provider: string) {
    if (provider !== GOOGLE_OAUTH_PROVIDER) return []
    const models = await super.listModels(KELVIN_GOOGLE_PROVIDER)
    return models.map(model => ({ ...model, provider }))
  }
}

/**
 * Force google-auth-library's gaxios transport onto native fetch. Native fetch
 * shares the process-wide undici dispatcher, which applies the live Google
 * Provider VLESS choice to OAuth exchange, refresh, discovery, and generation.
 */
export function createRoutedGeminiOAuthClient(clientId: string, clientSecret: string) {
  const client = createGeminiOAuthClient(clientId, clientSecret)
  client.transporter.defaults.fetchImplementation = globalThis.fetch
  return client
}
