# Inventory — Host / Identity / Daemon surfaces vs static Pages (2026-10-08)

Tyler correction: the Host API, daemon API, and Identity API must **not** be
required backends for `apps/pages`. The PWA is a purely static web app. Session
serving is browser-hosted WebRTC. A relay peer (ADR 0181) is optional durable
storage only. Grok Build returned HTTP 402 on
`scripts/dev/grok-headless.sh` (2026-10-08); this inventory and follow-up edits
are Cursor Agent with honest authorship.

Status tags: `pages-boot` (must be empty/absent for static) · `optional-relay`
· `operator-plane` (CLI/compose; not Pages boot) · `vercel-serverless` (must go
for static Vercel) · `remove-from-pages-wiring`.

## 1. Env / deploy stamps

| Surface | Paths | Status |
| --- | --- | --- |
| `PAGES_IDENTITY_API` → `identityApi` | `spec/config/endpoints.json` (`pagesRuntimeKey`); `apps/pages/scripts/write-runtime-config.mjs`; `.github/workflows/deploy-pages.yml`; `scripts/release/deploy-pages.sh`; `docs/operators/publishing.md`; `docs/audit/2026-10-p3-vercel-default-services.md`; `docs/audit/2026-10-publishing-dry-run.md` | `remove-from-pages-wiring` |
| `PAGES_HOST_API` → `hostApi` | same | `remove-from-pages-wiring` |
| `PAGES_DAEMON_API` → `daemonApi` | same (`loopbackOnly: true`) | `remove-from-pages-wiring` |
| `PAGES_CONNECT_CALLBACK_BASE` | `write-runtime-config.mjs`; `apps/pages/vercel.json` buildCommand | `vercel-serverless` (points at `apps/pages/api`) |
| `PAGES_SUPPORT_AGENT_URL` | `write-runtime-config.mjs` | optional AG-UI; not Identity/Host/daemon |
| `VITE_HOST_API` / `VITE_IDENTITY_API` / `VITE_DAEMON_API` | `endpoints.json`; `scripts/dev/pages-dev.sh`; `packages/app-core/src/lib/settings.ts` | `operator-plane` local full-stack only |
| `OPENSESAME_HOST_API` / `OPENSESAME_IDENTITY_API` / `OPENSESAME_DAEMON_API` | `endpoints.json`; CLI / services | `operator-plane` |

Shipped empty file: `apps/pages/public/os-runtime-config.json` = `{}` (`pages-boot`).

## 2. Runtime config / settings

| Surface | Paths | Status |
| --- | --- | --- |
| `loadRuntimeConfig` / `applyRuntimeConfig` | `packages/app-core/src/lib/runtime-config.ts`; `apps/pages/src/bootstrap/boot.ts` | `pages-boot` — empty/`absent` OK |
| Settings keys `hostApi` / `identityApi` / `daemonApi` | `packages/app-core/src/lib/settings.ts`; virtual settings files | `remove-from-pages-wiring` as defaults/suggestions for static |
| Endpoints UI (Connections service + Local agent) | removed (`EndpointsPanel.tsx` deleted) | done — no Host/daemon fields in Settings |
| WaysIn identity address | `apps/pages/src/screens/setup/WaysIn.tsx` | remote Identity optional; device plane is default |
| `useHostConfigured` | `apps/pages/src/lib/use-configured.ts` — already always `false` (ADR 0128) | dead gate |

## 3. Services / crates (still in the monorepo)

| Service | Paths | Status |
| --- | --- | --- |
| Host API | `crates/gateway`, `apps/cli` `opensesame host run`, `:8787` | `operator-plane` — must not be a Pages required backend |
| Identity API | `packages/control-plane`, `:8788` | `operator-plane` — must not be a Pages required backend |
| Daemon | `crates/daemon`, `opensesame daemon run`, `:18790` | `operator-plane` / loopback — must not be a Pages required backend |
| Vault relay profile | `OPENSESAME_GATEWAY_PROFILE=relay`; `/v1/vault-relay/*`; `packages/app-core/src/lib/vault-relay/` | `optional-relay` durable peer (ADR 0181), never required for boot or live join |
| Mock IdP | `tools/mock-upstream-idp` | `operator-plane` local |

## 4. Vercel serverless under `apps/pages` (forbidden for static export)

| Surface | Paths | Status |
| --- | --- | --- |
| Connect / GitHub App / git-backup routes | `apps/pages/api/**` | `vercel-serverless` — excluded by `.vercelignore` |
| Local relay helpers | `apps/pages/server/**` | kept for Pages `tsc` (connect-conformance); not in `dist/` |
| `vercel.json` → `dist/` only | `apps/pages/vercel.json` | static export; no server functions |

## 5. Compose / ops

| Path | Status |
| --- | --- |
| `ops/compose/docker-compose.yml` (gateway + deps; no control-plane) | `operator-plane` |
| `ops/ingress/`, `ops/nats/` | `operator-plane` |

## 6. Session serving (correct product path)

| Path | Role | Status |
| --- | --- | --- |
| `packages/app-core/src/lib/live/*` | Browser↔browser WebRTC | `pages-boot` path for sessions |
| `apps/pages` capability `sharing.live` | Join road / live sessions | required product surface |
| `verify:live-join` / `verify:live-netns` | Playwright WebRTC walks | proof, no app backend for direct |
| `sharing.relay` + `verify:relay-join*` | Optional durable peer | `optional-relay` |

## 7. Docs that claimed “default services”

| Path | Status |
| --- | --- |
| `docs/audit/2026-10-p3-vercel-default-services.md` | Wrong — rewrite to static-only |
| `docs/operators/publishing.md` § Vercel | Remove Host/Identity/`PAGES_*` requirement |
| `docs/audit/2026-10-requested-items.md` P3 row | Update |
| `docs/audit/2026-10-publishing-dry-run.md` | Update |

## 8. Tests / CI that still start backends for Pages-adjacent gates

| Job / script | Backend | Status after this stack |
| --- | --- | --- |
| `verify:static` / device-identity / device-inbox / tutorials / checklist walk | none | keep — static proof |
| `verify:live-join` | none for direct WebRTC | keep — session proof |
| `verify:push` | in-process control-plane | Identity-plane product; not Pages boot |
| `verify:relay-join-live` | `opensesame host run --profile relay` | optional relay only; must not be required for P3 |

## Residual (called out, not deleted in the first Pages wiring PRs)

The Host, Identity, and daemon **crates/packages remain in the monorepo** for
CLI and operator tooling. They are no longer stamped into Pages, no longer
documented as Vercel default services, and must not be required for
`apps/pages` boot, session serve, or static deploy. Deleting the authority /
Identity plane packages entirely is a separate plane-removal stack if Tyler
wants the git tree to drop them next.
