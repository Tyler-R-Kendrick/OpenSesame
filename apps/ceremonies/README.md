# @opensesame/ceremonies

Hosted ceremony pages on the Identity plane: a Vite + React app where each
route is one complete, shareable ceremony with no product-app chrome. Real
traffic arrives deep-linked (a `#token=` fragment, a `?user_code=`, an
approval reference), finishes the one thing the link is for, and ends. The
pages talk to the Identity API, and to the Host API where a delegation offer is
claimed.

## Where it fits

- **Used by:** people following links minted elsewhere —
  [`@opensesame/ceremony-kit`](../../packages/ceremony-kit) builds the canonical
  interaction URLs, and [`apps/mobile-mfa`](../mobile-mfa) links here. The
  Identity API allows this origin through CORS
  (`apps/control-plane/src/__tests__/ceremonies-cors.test.ts`).
- **Builds on:** [`@opensesame/ceremony-kit`](../../packages/ceremony-kit)
  (deep-link parsing, shared with Pages and the console),
  [`@opensesame/sdk-browser`](../../packages/sdk-browser),
  [`@opensesame/vault-core`](../../packages/vault-core) (secret-drop format),
  [`@opensesame/os-domain`](../../packages/os-domain).
- One ceremony per page ([ADR 0045](../../docs/adr/0045-hosted-ceremony-pages.md)).
  A secret-drop key travels in the URL fragment, never the query
  ([ADR 0062](../../docs/adr/0062-secret-drop.md)).

## Surface

| Route | Page | Ceremony |
|---|---|---|
| `/` | `Home` (in `App.tsx`) | Index that explains a bare visit |
| `/claim` | `ClaimCeremony` | Accept an ownership or delegation claim (`#token=osc_clm_…`); a secret drop is a branch of this page (`DropAcceptance`) |
| `/guest` | `GuestSession` | Start a provisional guest identity |
| `/device` | `DeviceApprove` | Approve a device by user code (`?user_code=…`) |
| `/delegate` | `DelegateClaim` | Accept delegated connector access |
| `/inbox` | `Inbox` | Requests waiting on you |
| `/approve/:ref` | `ApprovalReview` | Review and settle one approval |
| `/notifications` | `NotificationSettings` | Channels and destinations for prompts |
| `/invoke/:kind` | `AuthenticatorInvocation` | Authenticator hand-off: `mfa`, `oid4vp`, `oid4vci` |

Build-time origins (`src/lib/issuer.ts`): `VITE_OPENSESAME_ISSUER` (default
`http://127.0.0.1:8788`), `VITE_OPENSESAME_CONSOLE` (`http://127.0.0.1:5173`),
`VITE_OPENSESAME_GATEWAY` (`http://127.0.0.1:8787`).

## Develop

```bash
pnpm --filter @opensesame/ceremonies dev         # vite on :5181
pnpm --filter @opensesame/ceremonies build       # tsc -b, vite build, .well-known files
pnpm --filter @opensesame/ceremonies preview     # :5181
pnpm --filter @opensesame/ceremonies typecheck
pnpm --filter @opensesame/ceremonies test        # vitest run
```

`pnpm dev` at the root starts this app with the Identity plane.
`scripts/write-authenticator-associations.mjs` writes
`dist/.well-known/apple-app-site-association` and `assetlinks.json` for
`/invoke/*` when `OPENSESAME_IOS_APP_IDENTIFIER`,
`OPENSESAME_ANDROID_PACKAGE_NAME` and
`OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS` are all set; with none set it
skips, and with only some set the build fails.

## Related

- [ADR 0045](../../docs/adr/0045-hosted-ceremony-pages.md) — hosted ceremony pages
- [ADR 0062](../../docs/adr/0062-secret-drop.md) and [design: secret drop](../../docs/design/secret-drop.md)
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — deep links and the authenticator link scheme
