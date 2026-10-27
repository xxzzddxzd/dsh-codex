# Native Provider management API

The Provider publishes `POST /api/dsh-provider-settings` through Connection's exact Fetch registry when both the Web and Connection services exist. It uses the same Codex/xAI authentication controller instances, credential stores, durable preferences, model catalogs and VLESS service as the existing Web settings. It creates no new listener, credential copy or default-model selection.

Connection requires an owner Peer before invoking the route. A native gateway must authenticate its paired device first, choose its own fixed owner Peer, and call `connection.createSharedFetchHandler('/api').fetch(request, peer)`. Neither a URL nor a principal is accepted from the wire.

Requests are JSON `{ "action": "...", "payload": {} }`, limited to 16 KiB of UTF-8 bytes while streaming. Unknown actions, fields and provider identities are rejected. The only provider IDs are `provider-codex`, `provider-xai`, and `provider-google`.

Success returns `{ "ok": true, "value": ... }`. Input or operation failures return `{ "ok": false, "error": { "code": "provider-settings", "message": "..." } }`; authorization parameters and VLESS credentials are redacted. All responses are `no-store`. Owner admission refusals remain Connection's HTTP 403 response.

| Action | Payload | Value |
| --- | --- | --- |
| `overview` | `{}` | Components/version metadata, `settingsReady`, and managed provider identities/features |
| `auth.status` | `{provider}` | `status`, optional Codex usage/diagnostic or Google `configured` |
| `auth.login` | `{provider}` | HTTPS `{url,userCode?}` authorization challenge |
| `auth.logout` | `{provider}` | `{ok:true}` after the shared login owner has stopped and removed its credential |
| `models.get` | `{provider}` | `{models:[{id,name,visible?,contextWindow?,maxTokens?,defaultContextWindow?,defaultMaxTokens?}]}` |
| `models.set` | `{provider,models}` | Updated catalog, in the same shape as `models.get` |
| `images.get` / `images.set` | `{}` / partial `{modifyReadImage,shareImagegenWithOtherModels}` | Effective image preferences |
| `responses.get` / `responses.set` | `{}` / partial `{useWebSocketContextReuse,useNativeCompaction}` | Effective Responses preferences |
| `xai-image.get` / `xai-image.set` | `{}` / `{model}` | `{model,models:[{id,name}]}` |
| `egress.get` / `egress.set` | `{provider}` / `{provider,egress}` | Secret-free shared VLESS health and the selected provider's independent `direct`/`vless` exit |
| `vless.get` | `{}` | Secret-free VLESS health and Codex exit |
| `vless.configure` | `{vlessUrl}` | Validated and saved node health; never the URI |
| `vless.speed-test` | `{}` | VLESS health plus `latencyMs`, using the production proxy |

`models.set` replaces one provider's complete override array. Entries allow only `id`, `visible`, `contextWindow`, and `maxTokens`; clients must preserve other model overrides and omit read-only catalog metadata. An omitted override field restores that model's default.

Login/status requests are explicit operations. The endpoint has no polling timer. Native interfaces should poll only while a visible login operation is pending and cancel their own polling on background/exit. OAuth completion and cancellation remain owned by the shared backend controllers, including when a browser or native socket disconnects. Login URL queries and user codes must not be logged or persisted by clients.

The Provider API does not invoke model generation. Cline Pass and generic plugin configuration retain their own existing business/API owners; the native gateway can expose those separately through fixed, authenticated operations.
