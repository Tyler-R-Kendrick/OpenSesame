# Proof runs — plane deletion branch (2026-10-08)

Branch: `cursor/delete-host-identity-daemon-b359` (PR #865), static `dist/` only — **no** Host, Identity, or daemon processes.

Chromium: `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`.

Artifacts under `/opt/cursor/artifacts/delete-apis-proof/`.

## Pages build

`VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages` — **pass** (`pages-build.log`).

## Tutorials (all shards)

| Run | Result |
| --- | --- |
| `TUTORIALS_SHARD=1/3` (desktop+phone harness) | **5939 checks, 0 failed** |
| `TUTORIALS_SHARD=2/3` | **4164 checks, 0 failed** |
| `TUTORIALS_SHARD=3/3` | **4602 checks, 0 failed** |

Repeated with `WIDTH=1280` and `WIDTH=390` env (harness still walks both widths per shard). Logs: `tutorials-1280-*.log`, `tutorials-390-*.log`.

## Per-profile checklist walk

`node apps/pages/scripts/verification-checklist-walk.mjs` against static builds for `minimal-local`, `default`, `custom`, `full`.

Results: `/opt/cursor/artifacts/verification-2026-10/results.json` — **PARTIAL** on every profile (pre-existing U14 trash / R1–R3 reset-absent gaps; no Host/Identity regression). Shots under `/opt/cursor/artifacts/verification-2026-10/`.

## WebRTC host-and-join vault sync

`pnpm --filter @opensesame/pages verify:browser-sessions` — **ALL CHECKS PASSED** (`browser-sessions.log`). Transport artifacts: `/opt/cursor/artifacts/static-pwa-no-backend/transport`.

## Rust

`cargo +1.88.0 check --workspace --all-targets` — **pass**.  
`cargo +1.88.0 test -p opensesame-gateway -p opensesame-cli --lib --bins` — **126 tests pass** (`cargo-test-relay-cli.log`).

## `rg` gate

See `rg-gate.txt` — zero matches outside `docs/audit/`, `docs/evidence/`, `docs/archive/`.
