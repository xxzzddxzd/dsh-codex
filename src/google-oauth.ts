/** Google Code Assist integration sourced from @kelvinwww/dsh-oauth. */

import { createGeminiOAuthClient } from '@kelvinwww/dsh-oauth/gemini'

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
