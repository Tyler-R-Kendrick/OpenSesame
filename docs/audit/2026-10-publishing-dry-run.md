# 2026-10 checklist — publishing dry-run (agent VM)

Recorded on the Cursor Cloud agent VM after PR #776 workflows landed. No secrets were used.

| Item | Check | Result | Evidence |
| --- | --- | --- | --- |
| P1 GHCR | `docker build` / push | **BLOCKED** | `docker` CLI not installed on agent image |
| P1 GHCR | Workflow present | PASS | `.github/workflows/publish-containers.yml` (PR #776) |
| P2 npm | `npm publish --dry-run` | PASS | `@opensesame/os-domain@0.1.0` dry-run to registry.npmjs.org (no login) |
| P2 npm | Workflow present | PASS | `.github/workflows/publish-npm.yml` (PR #776) |
| P3 Pages build | `VITE_BASE=/OpenSesame/ turbo build --filter=@opensesame/pages` | PASS | Build completed; `dist/` + SW precache |
| P3 Vercel | Static `apps/pages` on Vercel, **no** Identity/Host/daemon env | CORRECTED | Tyler 2026-10-08: no default services. See [P3](2026-10-p3-vercel-default-services.md). |

## Commands

```bash
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
cd packages/os-domain && npm publish --dry-run
```

## Tyler actions

1. Run **Publish containers** workflow (or push `v*` tag) with `packages: write` on `GITHUB_TOKEN`.
2. Add `NPM_TOKEN`, clear `private` on packages to publish, run **Publish npm** workflow.
3. Link Vercel with root `apps/pages` and **no** Identity/Host/daemon env vars (static only).
