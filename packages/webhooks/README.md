# @opensesame/webhooks

Standard Webhooks signing and verification for the Identity plane, plus a
hardened HTTPS sender. The wire format is Standard Webhooks —
`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over
`id.timestamp.payload`, HMAC-SHA256 under a `whsec_` secret — so a receiver
can verify with any Standard Webhooks library. The root entry is pure
functions over `node:crypto`; the network lives only in the `./delivery`
subpath.

## Where it fits

- **Used by:** [`apps/worker`](../../apps/worker) (`src/webhooks.ts` signs and posts deliveries), [`apps/control-plane`](../../apps/control-plane) (`routes/webhooks.ts` mints and masks secrets), [`packages/notification-adapters`](../notification-adapters) (generic webhook, SMS bridge and Teams adapters).
- **Builds on:** [`@opensesame/oauth-provider`](../oauth-provider) — `./delivery` reuses its metadata safe-fetcher to refuse private destinations.
- The Host plane speaks the same convention in Rust: [`crates/gateway/src/security/delivery.rs`](../../crates/gateway/src/security/delivery.rs) mirrors this package's constants and refusals.
- `verifyWebhook` refuses a timestamp outside five minutes and does not say which check failed, so a refusal is not a signature oracle. MACs are compared in constant time.
- `postWebhook` sends only over HTTPS with no userinfo, to a public address resolved once and pinned, with redirects refused and a 10-second timeout.

## Surface

| Export | What it does |
|---|---|
| `generateWebhookSecret()` | A new `whsec_` secret (24 random bytes, base64) |
| `signWebhook(secret, id, timestampSeconds, payload)` | The three `webhook-*` headers |
| `verifyWebhook(secret, headers, payload, nowSeconds?)` | `true` or `false`; accepts any matching `v1` entry in a space-separated list |
| `maskWebhookSecret(secret)` | `whsec_…abcd` — what a GET route shows instead of the secret |
| `SECRET_PREFIX`, `SIGNATURE_VERSION`, `TIMESTAMP_TOLERANCE_SECONDS` | Constants |
| `postWebhook(url, init, lookupFn?)` from `@opensesame/webhooks/delivery` | The public-only, DNS-pinned sender |

## Develop

```bash
pnpm --filter @opensesame/webhooks test
pnpm --filter @opensesame/webhooks typecheck
```

A change to the signed content or header names must land in the Rust mirror
in `crates/gateway` at the same time.

## Related

- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — decision 12, Standard Webhooks
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — lifecycle hooks delivered in this format
- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) — notification channels
