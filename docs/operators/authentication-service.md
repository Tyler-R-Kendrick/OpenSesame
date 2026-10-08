# Self-host the authentication service — removed

**Status (2026-10-08):** The Identity API (`packages/control-plane`) and its
authentication-service admin UI were **deleted** from this repository. The Pages
PWA is a static app with no Identity backend (ADR 0090;
`docs/audit/2026-10-static-pwa-inventory.md`).

What remains for operators:

- **Static Pages** on GitHub Pages or Vercel — no backend stamp; see
  [`publishing.md`](publishing.md).
- **Optional vault relay peer** — GHCR image and `opensesame relay run` only;
  not an authentication service.
- **Browser-local IAM** and **device identity** — in the PWA without a hosted
  Identity API (ADR 0160).

Historical operator steps that referenced `pnpm --filter @opensesame/control-plane
start`, `pnpm db:migrate`, and deployment env vars live in git history before
branch `cursor/delete-host-identity-daemon-b359`.
