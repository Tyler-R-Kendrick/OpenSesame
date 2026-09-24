# @opensesame/notification-adapters

The Identity plane's notification channel adapters: one `ChannelAdapter`
contract and seven providers (Slack, Microsoft Teams, Telegram, WeChat, an SMS
bridge, Web Push and a generic webhook). An adapter renders a message, hands
it to a provider, and, where the provider signs its callbacks, verifies who a
callback came from. It decides nothing: settlement lives in
`@opensesame/os-domain`'s `evaluateDirectSettlement`, which is fed the facts
an adapter produced.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (channel kinds,
  capability records, confidentiality levels),
  [`@opensesame/webhooks`](../webhooks) (Standard Webhooks signing and
  delivery for the SMS and generic-webhook adapters) and
  [`@opensesame/oauth-provider`](../oauth-provider) (its safe-fetcher, for
  public-only delivery).
- An adapter's capabilities come from the os-domain catalogue; no adapter
  declares its own.
- All HTTP goes through an injected `fetch`, and provenance is checked over
  the raw bytes the provider sent.
- `RenderInput` has no field for a comparison code, and requester-supplied
  text is sanitized before rendering.
- Web Push and Teams endpoints are posted to only if every resolved address is
  public, with no redirects and the connection pinned to the verified address
  (`src/public-endpoint.ts`).

## Surface

| Area | Exports |
|---|---|
| Contract (`contract.ts`) | `ChannelAdapter` (`isConfigured`, `capabilities`, `render`, `deliver`, optional `verifyCallback` and `update`), `RenderInput`, `DeliveryOutcome`, `refuse` |
| Adapters (`adapters/`) | `createSlackAdapter`, `createTeamsAdapter`, `createTelegramAdapter`, `createWeChatAdapter`, `createSmsAdapter`, `createWebPushAdapter`, `createGenericWebhookAdapter` |
| Registry (`registry.ts`) | `createAdapterRegistry` |
| Rendering (`templates.ts`) | `renderNotification`, `sanitizeUntrustedText`, length limits |
| Helpers | `callbackDigest`, `secretsEqual`, `bytesEqual`, base64url, `classifyHttpStatus`, `DELIVERY_TIMEOUT_MS`, `isHttpsUrl` |
| `duressAlert` | Duress alert delivery mapping and a local delivery double; delivered is not received, and received is not acknowledged |

## Develop

```bash
pnpm --filter @opensesame/notification-adapters test
pnpm --filter @opensesame/notification-adapters typecheck
```

The suite runs offline against recorded `fetch` calls. Provider logic belongs
in this package and nowhere else.

## Related

- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) —
  external authorization notifications
- [`docs/operators/notification-channels.md`](../../docs/operators/notification-channels.md)
  — channel capability matrix and per-provider setup
- [`docs/security/notification-approval-threat-model.md`](../../docs/security/notification-approval-threat-model.md)
