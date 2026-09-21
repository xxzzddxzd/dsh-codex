/**
 * OpenAI Codex OAuth orchestration shared by the plugin and standalone launcher.
 * @module dsh-codex/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_PROVIDER,
  XaiCredentialStore,
  XAI_PROVIDER,
} from './store.ts'
import { routedProvider } from './routed-provider.ts'

/** Non-secret login state shown by the launcher. */
export interface OpenAICodexAuthStatus {
  /** Whether a stored OAuth credential exists. */
  authenticated: boolean
  /** Access-token expiry time; refresh is automatic on the next request. */
  expiresAt?: Date
}

/** Non-secret status shared by the xAI subscription page. */
export type XaiAuthStatus = OpenAICodexAuthStatus

/**
 * Complete provider-native OAuth and persist the resulting credential.
 * @param interaction - terminal or UI callbacks for the provider flow.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function loginOpenAICodex(
  interaction: AuthInteraction,
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<void> {
  const models = createModels({ credentials: store })
  models.setProvider(routedProvider(openaiCodexProvider(), OPENAI_CODEX_PROVIDER, 'Provider Codex'))
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
}

/**
 * Remove the stored OpenAI Codex credential.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 */
export async function logoutOpenAICodex(
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<void> {
  await store.delete(OPENAI_CODEX_PROVIDER)
}

/**
 * Read non-secret OpenAI Codex login state without refreshing the token.
 * @param store - credential store, defaulting under `$DSH_HOME`.
 * @returns stored login state and expiry.
 */
export async function openAICodexAuthStatus(
  store: OpenAICodexCredentialStore = new OpenAICodexCredentialStore(),
): Promise<OpenAICodexAuthStatus> {
  const credential = await store.read(OPENAI_CODEX_PROVIDER)
  return credential?.type === 'oauth'
    ? { authenticated: true, expiresAt: new Date(credential.expires) }
    : { authenticated: false }
}

/** Complete pi-ai's native SuperGrok/X Premium device-code flow. */
export async function loginXai(
  interaction: AuthInteraction,
  store: XaiCredentialStore = new XaiCredentialStore(),
): Promise<void> {
  const models = createModels({ credentials: store })
  models.setProvider(routedProvider(xaiProvider(), XAI_PROVIDER, 'Provider xAI'))
  await models.login(XAI_PROVIDER, 'oauth', interaction)
}

/** Remove only the xAI credential owned by this bundle. */
export async function logoutXai(
  store: XaiCredentialStore = new XaiCredentialStore(),
): Promise<void> {
  await store.delete(XAI_PROVIDER)
}

/** Read xAI login state without exposing or refreshing tokens. */
export async function xaiAuthStatus(
  store: XaiCredentialStore = new XaiCredentialStore(),
): Promise<XaiAuthStatus> {
  const credential = await store.read(XAI_PROVIDER)
  return credential?.type === 'oauth'
    ? { authenticated: true, expiresAt: new Date(credential.expires) }
    : { authenticated: false }
}
