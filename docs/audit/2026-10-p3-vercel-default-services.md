# P3 — Vercel static Pages (no default services)

**Correction (Tyler, 2026-10-08):** There is no “default services host.” The Host
API, daemon API, and Identity API are **not** backends for `apps/pages`. The
PWA is a purely static web app. Sessions are hosted in the browser over
WebRTC. A relay peer (ADR 0181) is an optional durable peer only — never a
required deploy dependency.

Inventory of remaining surfaces:
[`2026-10-static-pwa-inventory.md`](2026-10-static-pwa-inventory.md).

## Vercel project

| Field | Value |
|-------|--------|
| **Root Directory** | `apps/pages` |
| **Build** | `apps/pages/vercel.json` — `turbo run build --filter=@opensesame/pages`, then optional `write-runtime-config.mjs` with **no** required env |
| **Output** | `dist/` static assets only |
| **Server functions** | **None.** Do not deploy `api/` serverless routes. |
| **Required env vars** | **None.** |

Production may also use GitHub Pages via `deploy-pages.yml` (same static
`dist/`, empty `os-runtime-config.json` when no optional stamps are set).

## Runtime config

`os-runtime-config.json` ships as `{}`. Optional stamps that remain are
non-backend (for example a support-agent URL). **`PAGES_IDENTITY_API`,
`PAGES_HOST_API`, and `PAGES_DAEMON_API` are not used** for a correct static
deploy.

## Sessions and vault sync

1. One browser hosts a live session over WebRTC (`sharing.live`).
2. A second browser joins with the codes (no app server, no STUN/TURN by
   default).
3. Vault sync is peer-to-peer on that session. An operator may later name an
   optional relay peer (ADR 0181); that peer is never required to open or join
   a session.

## Operator checklist (static only)

1. Link the repo in Vercel with root `apps/pages` and the checked-in
   `vercel.json`.
2. Set **no** Identity/Host/daemon env vars.
3. Confirm the deployment serves `dist/` with SPA rewrites and no `/api`
   functions.
4. Smoke: open the origin, Skip as guest, start Join a session, second device
   joins — no backend processes.
