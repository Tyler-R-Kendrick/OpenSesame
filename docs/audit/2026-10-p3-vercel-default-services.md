# P3 — Vercel + default services (Tyler to-do)

Vercel preview checks are green on the stack; shipping a **hosted** Pages app that boots against default Identity/Host still needs operator wiring.

## Vercel project

| Field | Value |
|-------|--------|
| **Team** | The Vercel team linked to `Tyler-R-Kendrick/OpenSesame` (dashboard → team slug, e.g. `tyler-r-kendricks-projects`) |
| **Project** | Import repo with **Root Directory** `apps/pages` (build uses `apps/pages/vercel.json`: `turbo run build --filter=@opensesame/pages`, then `write-runtime-config.mjs`) |
| **Production branch** | `main` (optional Git integration; GitHub Pages already deploys static assets via `deploy-pages.yml`) |

No checked-in Vercel project id — create/link in the dashboard once.

## GitHub Actions variables (stamp `os-runtime-config.json`)

Set under **Settings → Secrets and variables → Actions → Variables** (same names as `deploy-pages.yml` and `spec/config/endpoints.json`):

| Variable | Maps to setting | Suggested value (default-services deployment) |
|----------|-----------------|-----------------------------------------------|
| `PAGES_IDENTITY_API` | `identityApi` | Public HTTPS URL of control-plane, e.g. `https://identity.<your-domain>` (port **8788** behind ingress) |
| `PAGES_HOST_API` | `hostApi` | Public HTTPS URL of Host API or **relay profile**, e.g. `https://host.<your-domain>` (port **8787**). Use relay URL if Pages should sync org vaults only. |
| `PAGES_DAEMON_API` | `daemonApi` | **Not usable from a browser on Vercel** — `daemon` is `loopbackOnly: true` in `spec/config/endpoints.json`. Leave unset for Vercel; tailnet/device features need a local daemon or a future non-loopback operator binding. |

Optional: `PAGES_CONNECT_CALLBACK_BASE` (site broker on same origin), `PAGES_SUPPORT_AGENT_URL`.

With all three core vars empty, build ships `{}` and the PWA stays offline-complete (ADR 0090).

## What to run for “default services”

1. **Host image** — `ghcr.io/<owner>/opensesame` from `publish-containers.yml` (workflow_dispatch or `v*` tag). Run `opensesame host run` (full API) or `OPENSESAME_GATEWAY_PROFILE=relay` for vault relay only.
2. **Identity** — `@opensesame/control-plane` (`pnpm --filter @opensesame/control-plane start`, port 8788) with Postgres + `OPENSESAME_EVENT_KEY` / claim pepper per `docs/operators/log-and-event-sealing.md`.
3. **Compose reference** — `ops/compose/` documents operator topology; there is **no** single “default services” SaaS URL in-repo — Tyler must deploy Host + Identity (or relay + Identity) and paste HTTPS origins into the `PAGES_*` variables above.

**Smallest concrete path:** one VM or compose stack with Caddy ingress → control-plane `:8788` and gateway `:8787`, then set `PAGES_IDENTITY_API` and `PAGES_HOST_API` to those HTTPS origins in GitHub Variables and redeploy Pages (GH Actions or Vercel).
