/** Route aliases for pi-ai providers owned by the Provider settings bundle. */

import type { Api, Model, Provider } from '@earendil-works/pi-ai'

/**
 * Clone a static pi-ai provider under a DSH-owned route ID.
 *
 * The upstream provider ID is also embedded in every model descriptor, so both
 * must move together. Keeping this alias at the pi-ai boundary lets Models-page
 * API-key routes such as `xai` coexist with Provider-page OAuth routes such as
 * `provider-xai`.
 */
export function routedProvider(provider: Provider, route: string, name: string): Provider {
  if (provider.refreshModels !== undefined) {
    throw new Error(`dynamic pi-ai provider "${provider.id}" cannot be assigned to route "${route}"`)
  }
  const routedModels = (): readonly Model<Api>[] => provider.getModels().map(model => ({
    ...model,
    provider: route,
  }))
  return {
    ...provider,
    id: route,
    name,
    getModels: routedModels,
  }
}
