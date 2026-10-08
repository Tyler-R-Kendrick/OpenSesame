# Inventory — plane deletion (Host / Identity / daemon) — 2026-10-08

Tyler (follow-up): Host API, daemon API, and Identity API **must not exist**.
They are not “operator/CLI residuals.” The PWA stays static. Sessions are
browser WebRTC. The **only** allowed server surface is the optional vault
relay peer (ADR 0181).

Grok Build: HTTP 402 on `scripts/dev/grok-headless.sh` (2026-10-08). This
stack is Cursor Agent with honest authorship.

Status: `delete` · `keep-relay` · `history-docs` · `cli-remove` · `cli-local`.

## Deleted planes (this PR)

Removed from the tree on branch `cursor/delete-host-identity-daemon-b359`:

- **Rust:** `crates/daemon`, `crates/worker` (workspace members dropped from root
  `Cargo.toml`). Host API code in `crates/gateway` stripped elsewhere on this
  branch; **`crates/gateway/src/vault_relay/` kept**.
- **TypeScript:** `packages/control-plane`, `packages/identity-worker`,
  `packages/database`, `packages/device-auth`, `packages/api-client`,
  `packages/webhooks`.
- **Tools:** `tools/mock-upstream-idp`.
- **Pages serverless:** `apps/pages/api/` (Vercel functions removed).
- **Root scripts:** `bootstrap` no longer runs Identity DB; `dev` no longer
  starts control-plane / identity-worker / mock IdP; removed `dev:host`,
  `dev:daemon`, `db:migrate`, `db:reset`, `generate:openapi`, `audit:daemon-deps`;
  added `dev:relay`.
- **Compose / GHCR:** `ops/compose/docker-compose.yml` is relay-only;
  `ops/compose/Dockerfile` default `CMD ["relay", "run"]`; publish/container PR
  workflow names document relay-only image.
- **Kept intentionally:** vault relay (`crates/gateway/src/vault_relay/*`),
  sealed-store, human-vault, app-core, Pages `src/` (not `api/`), relay client
  in app-core, `sharing.relay` capability. **`@opensesame/oauth-provider` kept**
  (notification-adapters + fuzz still depend on safe-fetcher helpers).

Deletion log: `docs/evidence/2026-10-08-static-pwa-no-backend/deleted-surfaces.md`.

## 1. Delete — services / crates / packages

| Surface | Paths | Status |
| --- | --- | --- |
| Host API (non-relay) | `crates/gateway` Host modules, Host profile | `delete` — crate stripped to vault-relay only (or renamed) |
| Daemon API | `crates/daemon`, `uds-authn`, `tailscale-authn`, `tailnet-admin` (daemon-side) | `delete` |
| Identity API | `packages/control-plane` | `delete` |
| Identity worker | `packages/identity-worker` | `delete` |
| Identity DB | `packages/database` | `delete` (Identity-plane only) |
| Mock IdP | `tools/mock-upstream-idp` | `delete` |
| Pages serverless | `apps/pages/api/**` | `delete` |
| Host TS client | `packages/api-client` | `delete` |
| Device-auth (Identity) | `packages/device-auth` | `delete` |
| Worker host role | `crates/worker` + `opensesame worker run` | `delete` (Host plane) |
| Compose Host stack | `ops/compose/docker-compose.yml` gateway/worker/deps | `delete` or relay-only |
| GHCR `opensesame` Host image | `.github/workflows/publish-containers.yml`, `container-build-pr.yml`, `ops/compose/Dockerfile` | retarget relay-only or drop |

## 2. Keep — optional durable peer

| Surface | Paths | Status |
| --- | --- | --- |
| Vault relay | `crates/gateway/src/vault_relay/*` → relay-only crate/binary | `keep-relay` |
| Relay client | `packages/app-core/src/lib/vault-relay/` | `keep-relay` |
| Pages capability | `apps/pages/src/modules/sharing.relay/` | `keep-relay` |
| ADR 0181 | `docs/adr/0181-*.md` | `keep-relay` |

## 3. Env / stamps — must vanish from live config

| Key | Status |
| --- | --- |
| `OPENSESAME_HOST_API` / `PAGES_HOST_API` / `VITE_HOST_API` / `hostApi` | `delete` from `endpoints.json` + settings |
| `OPENSESAME_IDENTITY_API` / `PAGES_IDENTITY_API` / `VITE_IDENTITY_API` / `identityApi` | `delete` |
| `OPENSESAME_DAEMON_API` / `PAGES_DAEMON_API` / `VITE_DAEMON_API` / `daemonApi` | `delete` |
| Relay envs (`OPENSESAME_GATEWAY_PROFILE=relay`, bindings, registration JWKS, `OPENSESAME_RELAY_*`) | `keep-relay` (rename off “gateway” where practical) |

Gate: `rg -i 'identity_api|host_api|daemon_api|PAGES_(IDENTITY|HOST|DAEMON)'` empty outside `docs/audit/` history and this inventory’s history notes.

## 4. CLI verbs

| Verb | Fate |
| --- | --- |
| `opensesame host run` | → `opensesame relay run` (relay only) |
| `opensesame daemon *` | `cli-remove` |
| `opensesame worker run` | `cli-remove` |
| Host HTTP clients (`login` device-to-Host, `access *` Host, `config *` Host, `security *` Host, `hooks policy` Host, …) | `cli-remove` unless rewritten to local/P2P/relay |
| `opensesame-id` Identity verbs | `cli-remove` or local-only vault verbs kept |
| `pass`, `vault`, local sealed-store | `cli-local` keep |

## 5. Docs / publish

| Path | Status |
| --- | --- |
| `docs/audit/2026-10-p3-vercel-default-services.md` | static-only (already) |
| `docs/operators/publishing.md`, GHCR/npm publish docs | no Host/Identity image; relay-only if any |
| `docs/operators/local.md`, `health-and-operations.md`, Identity admin docs | rewrite or archive |
| `docs/audit/2026-10-requested-items.md` P3 | mark deleted |

## 6. Proof

Static Pages build; no Host/Identity/daemon processes. Full `verify:tutorials` (all shards), checklist walk, `verify:browser-sessions` WebRTC vault sync. Green CI including Rust on this PR and #861.
