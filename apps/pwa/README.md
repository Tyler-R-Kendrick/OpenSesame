# @opensesame/pwa

A thin client PWA on the Client plane (Vite + React). It shows Host API
health, whether the optional local daemon answers, and a client-core sync
cursor persisted as a sealed store in OPFS, and it signs a person in to the
Identity API or continues as a guest. It also registers a small WebMCP catalog.
The full application is [`apps/pages`](../pages); this shell stays minimal.

## Where it fits

- **Used by:** nothing in the workspace depends on it. Its bundle is budgeted
  in [`tools/quality/bundle-budgets.json`](../../tools/quality/bundle-budgets.json).
- **Builds on:** [`@opensesame/api-client`](../../packages/api-client)
  (`health`, `probeDaemon`), [`@opensesame/client-core`](../../packages/client-core)
  (`createCursor`, `loadSealedStore`, `persistSealedStore`,
  `assertNoPlaintextInSealedJson`), [`@opensesame/sdk-browser`](../../packages/sdk-browser)
  (sign-in, guest, sign-out; client id `opensesame-pwa`),
  [`@opensesame/webmcp`](../../packages/webmcp).
- Sealed JSON is checked for plaintext before it is persisted, and the source
  never calls `getSecret(` (`src/pact.test.ts`).
- WebMCP tools only read status or open the sign-in UI; signing in stays with
  the human ([ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Surface

| Piece | What it does |
|---|---|
| `src/App.tsx` | Status panel (Host API, daemon, sync cursor), sign-in, guest, sign-out, refresh |
| `src/webmcp.ts` | `registerPwaWebMcp`: `opensesame_pwa_status`, `opensesame_pwa_health`, `opensesame_open_sign_in` |
| `src/client-core.ts`, `src/api-client.ts`, `src/sdk-browser.ts` | Test seams over the workspace clients |
| `public/manifest.webmanifest` | Install manifest; there is no service worker |

Build-time variables: `VITE_HOST_API` (default `http://127.0.0.1:8787`) and
`VITE_OPENSESAME_ISSUER` (default `http://127.0.0.1:8788`).

## Develop

```bash
pnpm --filter @opensesame/pwa dev          # vite on :5176
pnpm --filter @opensesame/pwa build
pnpm --filter @opensesame/pwa typecheck
pnpm --filter @opensesame/pwa test         # vitest run
```

`pnpm quality:bundle` builds this app and checks its budget. The WebMCP tool
list is swept against [`@opensesame/capability-registry`](../../packages/capability-registry)
in `src/webmcp.test.ts`.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [ADR 0085](../../docs/adr/0085-pwa-install-offer.md) — PWA install offer (this shell ships a manifest, no service worker)
