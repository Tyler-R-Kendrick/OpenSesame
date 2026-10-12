# Evidence — static PWA, no Host/Identity/daemon backend (2026-10-08)

PR: [#861](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/861)  
Branch tip: `353d7737` (Endpoints removed; Vercelignore api-only)
Producer: Cursor Agent (Grok Build HTTP 402)

## What was proved (no backend processes)

Confirmed with `pgrep` before each run: no `opensesame host`, `opensesame daemon`, or control-plane.

| Gate | Result | Artifacts |
| --- | --- | --- |
| Unit: Settings Endpoints removal | 32 passed | `/opt/cursor/artifacts/static-pwa-no-backend/unit-settings.log` |
| `verify:browser-sessions` (3 Chromium processes, strict-direct WebRTC, vault item sync + edit) | ALL CHECKS PASSED | `/opt/cursor/artifacts/static-pwa-no-backend/browser-sessions/` |
| `LIVE_SCENARIOS=direct verify:live-join` | ALL CHECKS PASSED | `/opt/cursor/artifacts/static-pwa-no-backend/live-join/` |
| `verify:transport` (incl. stamped hostApi not probed) | ALL CHECKS PASSED | `/opt/cursor/artifacts/static-pwa-no-backend/transport/` |
| Checklist walk (minimal-local + default, rebuilt profiles) | PARTIAL (U14 trash / R1–R3 reset-absent — pre-existing; Capabilities has no Endpoints) | `/opt/cursor/artifacts/verification-2026-10/` |
| `TUTORIALS_SHARD=1/3 verify:tutorials` | 5939 checks passed, 0 failed | `/opt/cursor/artifacts/static-pwa-no-backend/tutorials-shard1.log` |

## Screenshots

Copied under `/opt/cursor/artifacts/static-pwa-no-backend/screenshots/`:

- `direct-1-owner-live.png` / `direct-2-joiner-revealed.png` — WebRTC host/join, secret revealed
- `default-settings-capabilities.png` — Capabilities with **no Endpoints panel**
- `default-front-door.png` — front door on static build

## Static Vercel

Root `apps/pages`, `vercel.json` → `dist/`, no required env. `.vercelignore` excludes `api/` only (so `server/` remains for `tsc`; output is still static `dist/`).
