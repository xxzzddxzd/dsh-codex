/** Browser half: OpenAI Codex account management inside dsh Settings. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { ProviderSettings } from './ProviderSettings.tsx'
import type { ProviderSettingsInjected } from './ProviderSettings.tsx'
import { VlessSettings } from './VlessSettings.tsx'
import type { VlessSettingsInjected } from './VlessSettings.tsx'
import { ImagegenToolView } from './ImagegenToolView.tsx'
import { en, zh } from './locales.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'
import { vlessEn, vlessZh } from './vless-locales.ts'
import type { VlessSettingsKey } from './vless-locales.ts'
import { providerEn, providerZh } from './provider-locales.ts'
import type { ProviderSettingsKey } from './provider-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenAI Codex account page copy. */
    'settings.openai-codex': OpenAICodexSettingsKey
    /** Device-local VLESS configuration page copy. */
    'settings.vless': VlessSettingsKey
    /** Provider hub and provider subpage copy. */
    'settings.providers': ProviderSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-codex-client'
/** Client services required by the settings contribution. */
export const inject = ['slots', 'locale']

/** Register account copy and the OpenAI Codex settings page. */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.openai-codex'
  const vlessNamespace = 'settings.vless'
  const providerNamespace = 'settings.providers'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-openai-codex: settings copy')
  ctx.effect(() => ctx.locale.register(vlessNamespace, { zh: vlessZh, en: vlessEn }), 'dsh-openai-codex: VLESS settings copy')
  ctx.effect(() => ctx.locale.register(providerNamespace, { zh: providerZh, en: providerEn }), 'dsh-providers: settings copy')
  const t = ctx.locale.bind(namespace) as OpenAICodexSettingsInjected['t']
  const vlessT = ctx.locale.bind(vlessNamespace) as VlessSettingsInjected['t']
  const providerT = ctx.locale.bind(providerNamespace) as ProviderSettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vless',
    order: 14,
    label: () => vlessT('nav'),
    inject: (): VlessSettingsInjected => ({ t: vlessT }),
  }, VlessSettings))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'providers',
    order: 15,
    label: () => providerT('nav'),
    inject: (): ProviderSettingsInjected => ({ t: providerT, openaiT: t }),
  }, ProviderSettings))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'imagegen',
    inject: (): { t: OpenAICodexSettingsInjected['t'] } => ({ t }),
  }, ImagegenToolView))
}
