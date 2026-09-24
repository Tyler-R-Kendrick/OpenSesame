# @opensesame/browser-extension

A WXT (Manifest V3) browser extension on the Client plane. Its background
service worker reports Host API health, whether the local daemon answers, and
a client-core sync cursor; the popup shows that status and lets the user set
the Host API base. It never exposes a secret or a `getSecret()` affordance to a
web page.

## Where it fits

- **Used by:** nothing in the workspace depends on it; it is loaded into a
  browser. Setup for people and agents is in
  [skills/opensesame-chrome-extension](../../skills/opensesame-chrome-extension/SKILL.md).
- **Builds on:** [`@opensesame/api-client`](../../packages/api-client)
  (`createApiClient`, `normalizeLoopbackBaseUrl`),
  [`@opensesame/client-core`](../../packages/client-core) (`createCursor`,
  `persistSealedStore`), [`@opensesame/os-domain`](../../packages/os-domain).
- The Host API base is loopback only. The popup refuses a non-loopback URL
  before it is stored, and the background ignores a stored value that no
  longer normalizes to loopback and falls back to `http://127.0.0.1:8787`.
  `host_permissions` is limited to `http://127.0.0.1/*` and
  `http://localhost/*`.

## Surface

| Piece | What it does |
|---|---|
| `entrypoints/background.ts` | Creates the sync cursor (`extension-device`), persists an empty sealed store on install, and answers runtime messages |
| `opensesame.health` message | Returns `{ health, daemon, discovery, cursor, hostBase }` from `client.health()`, `client.probeDaemon()` and `client.discover()` |
| `opensesame.sync_cursor` message | Returns `{ cursor }` |
| `entrypoints/popup/` | Status list (Host API, daemon, sync cursor) and the Host API base field, stored as `hostApiBase` in `chrome.storage.local` |
| `wxt.config.ts` | Manifest: `storage` and `alarms` permissions, extension-page CSP `script-src 'self'`, build target `chrome111`/`firefox115` |

## Develop

```bash
pnpm --filter @opensesame/browser-extension dev            # wxt dev
pnpm --filter @opensesame/browser-extension build          # wxt build
pnpm --filter @opensesame/browser-extension test           # node --test tests/pact.test.mjs
pnpm --filter @opensesame/browser-extension test:install   # playwright install chromium
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @opensesame/browser-extension test:e2e     # live-gateway suite
```

`tests/pact.test.mjs` checks the source order of the loopback fence (normalize
before store, normalize before use) and that no `getSecret(` appears. The
Playwright suite in `tests/auth-surface.spec.ts` is skipped unless
`PLAYWRIGHT_BASE_URL` points at a running gateway; it reads
`OPENSESAME_OPERATOR_TOKEN` for the operator header.

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — ConnectionRef, no `getSecret()`
- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology
- [ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) — the extension as a second ceremony runner
- [Audit: extension Host API loopback fence](../../docs/security/audits/2026-08-08-extension-host-fence.md)
