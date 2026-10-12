# Browser-session acceptance

> Status (2026-10-08): a point-in-time proof record. The walk it describes is
> still `pnpm test:browser-sessions` (`apps/pages/scripts/verify-browser-sessions.mjs`);
> the `pageshow` and bfcache claim comes from the separate
> `pnpm --filter @opensesame/pages verify:browser-session-lifecycle`. The
> Measurements table is that commit's numbers and ceilings, not today's:
> `tools/quality/bundle-budgets.json` now holds `apps/pages` at
> 17900 / 5630 / 1739 / 168 / 12800 and both hardened profiles at
> 4767 / 4164 / 1259 / 171 / 693 (total / javascript / javascriptGzip / css /
> largestAsset, KiB).

Status: local proof against the shipped Pages build. `pageshow.persisted=true` bfcache restoration is claimed from two history-back runs: each browser `pageshow` was trusted with `persisted: true`, `PerformanceNavigationTiming.type` stayed `navigate` (the original load; the return was not a reload and `notRestoredReasons` was null), the peer could no longer read the shared field, and the restored document did not show a live session. Physical-device, live-provider, and native window-hide are not claimed.

## What this proves

`pnpm test:browser-sessions` builds the rich Pages app and drives three isolated Chromium processes against that build:

- Startup Join on a device with no vault (ADR 0150).
- The always-on drop claim ceremony (`/claim`, "Accept a claim") on that same empty device.
- A strict-direct live session (`iceServers: []`) between the other two processes. The runner only carries the sealed codes. The vault field moves on the browsers' real `RTCPeerConnection`.
- Scoped projection: the joiner can reveal the shared login and is not offered the login the owner left unchecked.
- Lifecycle: ending the session removes the revealed value and closes the peer connection.
- Authorized edit, after that read session has ended: the owner starts another strict-direct session with Values set to Can edit, the joiner replaces the shared GitHub password, and the owner sees the new password on the open vault item. The unchecked Payroll login is still not offered. The edit runs in the consented `sharing.live` graph. Both hardened profiles stay on the recorded largest-asset ceiling.

ADR 0150 shares a field as `read`, `use`, or `edit`. `edit` writes that one shared field back into the open vault. The session itself is not stored. Ceilings in `tools/quality/bundle-budgets.json` were not raised.

## Measurements

Sizes are this commit's bundle-budget gate over the Pages build and both hardened profiles. The index hash is that gate's `apps/pages` dist. Ceilings were not raised.

| Check | Result |
| --- | --- |
| Rich Pages `dist/index.html` SHA-256 | `53bb7b615476f8d4d227623c28d4cb0be1ee4ff5cc359747b2d1ee5c81f28b67` |
| `minimal-local-hardened` total / javascript / javascriptGzip / css / largestAsset (KiB) | 4737 / 4130 / 1256 / 152 / 793 (ceilings 4830 / 4211 / 1272 / 171 / 793) |
| `family-local-hardened` total / javascript / javascriptGzip / css / largestAsset (KiB) | 4737 / 4130 / 1256 / 152 / 793 (ceilings 4830 / 4211 / 1272 / 171 / 793) |
| `apps/pages` inside recorded ceilings | 6101 / 5373 / 1639 / 154 / 803 (ceilings 17900 / 5460 / 1650 / 168 / 12800) |
| `apps/console` | No `apps/console` package and no console ceiling in `tools/quality/bundle-budgets.json` on this tree |

Ceilings are the numbers already in `tools/quality/bundle-budgets.json` on this branch. None were raised.
