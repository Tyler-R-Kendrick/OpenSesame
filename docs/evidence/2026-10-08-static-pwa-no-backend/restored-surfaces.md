# Restored surfaces — Host / Identity / daemon (2026-10-09)

Branch: `cursor/restore-cli-backends-b359`, stacked on PR #865.

**Restoration note.** This file replaces the removal-era `deleted-surfaces.md`.
PR #865 deleted the Host / Identity / daemon planes from the monorepo; only the
PWA was meant to lose its backends (PR #861). Every surface below is restored
from the #861 tip (`03065913`). `apps/pages/api/` is the one deletion that
**stands** — the PWA stays static.

## Restored paths

| Area | Path |
| --- | --- |
| Daemon API | `crates/daemon/` |
| Worker host | `crates/worker/` |
| Host API (gutted by #865) | `crates/gateway/` (full restore) |
| Identity API | `packages/control-plane/` |
| Identity worker | `packages/identity-worker/` |
| Identity DB | `packages/database/` |
| Device auth (Identity) | `packages/device-auth/` |
| Host TS client | `packages/api-client/` |
| Webhook signing (Identity delivery) | `packages/webhooks/` |
| Mock upstream IdP | `tools/mock-upstream-idp/` |
| CLI verbs | `apps/cli` Host/Identity/daemon tree (see `restored-cli-commands.md`) |
| Tests | capability parity, CLI verb tests, mTLS host-process tests (`tests/mtls-interop`), redteam subjects, auth-upstream/database suites |

## Config / ops restored

- Root `Cargo.toml` / `Cargo.lock`: `crates/daemon`, `crates/worker` and the
  gateway's full dependency set back as workspace members.
- Root `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml`: Identity DB
  bootstrap, control-plane openapi generation, `tools/mock-upstream-idp` and
  the restored packages back as members/scripts.
- `ops/compose/docker-compose.yml` + `Dockerfile`: host/worker/identity
  services restored beside the optional relay profile (not relay-only).
- `.github/workflows/publish-containers.yml`, `container-build-pr.yml`,
  `ci.yml`, `full-suite.yml`, `publish-npm.yml`: host/daemon image entries and
  the CI job matrix as on #861.
- `docs/operators/publishing.md`: GHCR host image documented again (relay is
  an optional profile, not the whole image).

## Intentionally NOT restored (PWA stays static, PR #861)

- `apps/pages/api/**` — Vercel serverless routes; the PWA is backend-free.
- `PAGES_IDENTITY_API` / `PAGES_HOST_API` / `PAGES_DAEMON_API` stamps and the
  Settings Endpoints panel — absent by design.
- #865's local-only CLI rewrites (`vault_relay_sync.rs`, local `doctor` /
  `tui` / `security` / `vault secret|sync|crypto`) — superseded by the
  restored Host-backed defaults.

## Verification

- `cargo +1.88.0 test` for `opensesame-gateway`, `opensesame-daemon`,
  `opensesame-cli` (and the workspace as CI scopes it).
- `pnpm test` for the restored TS packages.
- Static checklist walk (`minimal-local`, `default`, `custom`, `full`) and
  `verify:browser-sessions` with no backend processes — 0 failed checks.
- Pages backend-free guard test: `apps/pages` imports of
  `@opensesame/control-plane` / `api-client` / `database` / `device-auth` /
  `identity-worker` / `webhooks` or `crates/daemon|worker` fail the suite.
