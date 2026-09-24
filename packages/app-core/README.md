# @opensesame/app-core

The Client-plane application core shared by the Pages PWA, the Client CLI and
Android: the vault store and its tombs, identity and federation, browser-local
IAM, connectors, duress, SOPS, the WebMCP tools, the support registries and
the screens' view-models. It holds everything in the client that is not UI,
laid out as `apps/pages/src` was. It has no React and no DOM shell; a shell
plugs in through one host.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (installs the browser host
  first thing in `main.tsx`) and [`packages/cli`](../cli) (the Node host).
- **Builds on:** [`vault-core`](../vault-core) (the vault format),
  [`vault-item-types`](../vault-item-types), [`os-domain`](../os-domain),
  [`capability-composition`](../capability-composition),
  [`capability-registry`](../capability-registry),
  [`api-client`](../api-client), [`contracts`](../contracts),
  [`guide-lang`](../guide-lang) and [`support-agent`](../support-agent).
- **Host and ports.** A shell calls `configureHost` (`src/host.ts`) once,
  before any other module does work. Everything platform-specific is a port in
  `src/ports.ts` (storage, page, authenticator, environment, locks, broadcast,
  worker, service worker, OPFS, IndexedDB), read when used, never at import.
  Standard web APIs (`crypto`, `fetch`, `URL`, timers) are the runtime
  contract, not ports. `src/no-host-import.test.ts` imports every module with
  no host installed and fails on one that touches a port while loading.
- **Boundary gate.** `pnpm quality:app-core` fails on any reach into an app,
  any React value, `import.meta.env`, a Vite virtual module, `node:*` outside
  `src/node`, a browser global outside `src/browser`, or a static import
  cycle. Lazy cycle edges are recorded in `layering-baseline.json` and only
  shrink.

## Surface

There is no root entry. Import by path: `"./*.js"` maps to `src/*.ts`, for
example `@opensesame/app-core/lib/vault/store.js`.

| Area | What it holds |
|---|---|
| `src/host.ts`, `src/ports.ts` | `configureHost`, `host()`, `env()`, `composeHost`, and the port accessors (`localStore`, `page`, `credentials`, `lockManager`, `originFiles` …) |
| `src/browser/` | The browser host; the one place outside worker entries that touches browser globals |
| `src/node/` | The Node host for the CLI; local storage is a `0600` file under `$OPENSESAME_STATE_DIR` (default `~/.local/state/opensesame`) |
| `src/sandbox/` | The host for a bare V8 isolate such as Android's JavaScriptSandbox, plus `runtime-contract.ts`; proven by `bare-isolate.test.ts` |
| `src/lib/` | The core: `vault/` (store, tombs, drops, backup, import/export), `capabilities/` (catalog, features, loader, leases), `ambient-auth/`, `join/`, `claims/` (the ownership-claim ceremony, ADR 0140), `interactions.ts` (cross-device interaction approval: ceremony-kit's model over the Identity transport, the WebAuthn port and the `/i/<ref>` link, ADR 0140), `approvals.ts` (authorization-request review and the hosted inbox rows: ceremony-kit's review over the Identity transport and the same WebAuthn port, ADR 0084/0140), `notification-routing/` (where a person is notified: a serializable routing document with pure edits for a future Settings file, channel words from os-domain's capability record, and the Identity API routes, ADR 0084/0140), `duress/`, `sops/`, `configuration/`, `command-bar/`, `item-type-marketplace/`, plus settings, identity, federation, connections, connector directory, local IAM and guest access modules |
| `src/sections/`, `src/screens/`, `src/components/`, `src/routes/` | View-models (`*-model.ts`) for the Pages sections and screens, and Settings as virtual files (`sections/settings/virtual-files.ts`) |
| `src/tutorial/` | Support registries (`registry/`) and the on-device, AG-UI and provider agents (`agents/`) |
| `src/webmcp/` | The WebMCP tool definitions and registration |

## Develop

```bash
pnpm --filter @opensesame/app-core test
pnpm --filter @opensesame/app-core typecheck
pnpm quality:app-core
```

Tests run in Node with `src/test-setup.ts` installing a test host;
`vitest.config.ts` aliases `@opensesame/os-domain` to its browser entry, the
one Pages ships. `scripts/sops-oracle/` fetches a pinned, checksum-verified
upstream SOPS release for the SOPS conformance and oracle tests; the shipped
browser never runs it.

## Related

- [ADR 0133](../../docs/adr/0133-shared-app-core.md) — the shared core, its host and ports
- Capabilities: [ADR 0130](../../docs/adr/0130-operator-controlled-capability-composition.md),
  [ADR 0135](../../docs/adr/0135-always-on-capabilities-and-feature-rollups.md);
  Settings as files: [ADR 0134](../../docs/adr/0134-item-type-marketplaces-and-settings-files.md);
  join: [ADR 0136](../../docs/adr/0136-join-a-session-restored.md);
  SOPS: [ADR 0130](../../docs/adr/0130-browser-local-sops.md)
