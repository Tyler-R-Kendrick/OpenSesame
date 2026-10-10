# Lock-v5 unlock title screen

Before/after from **live GitHub Pages** (`main`) vs **this branch’s production build** (`apps/pages/dist` via the static harness). Journey: pass the front door → seal a PIN vault → lock → capture the settled gate; on the branch build only, unlock and capture a mid-doors frame.

Widths: **390**, **1024**, **1280** px.

## Approved design (lock-v5 / PR #947 + #1012 wordmark)

- Hero **CipherWordmark** (`includeMark`, up to 90em) above the unlock card, not inside the brand row.
- **CipherDial** (eleven rings on the column seam) idle on the gate; aligns on successful unlock.
- **VaultDoors** split animation after unlock; `unlockCeremonyStore` holds the gate until doors finish.
- **Release notes** beside the card on wide layouts; newest row label `Release notes · {version}` (#778 / lock-v5).
- Guest/join/reset roads and unlock behavior unchanged (ADR 0090).

## Gaps vs live GitHub Pages (main)

| Live (main) | This branch |
| --- | --- |
| `Wordmark` at 28px inside `.unlock__card` | Hero wordmark in `.unlock__hero` |
| No CipherDial / VaultDoors | Dial + doors ceremony |
| `Release notes` h2 + version rows | `Release notes · {version}` on newest row only |
| Card-only hierarchy | Hero + dial own the title band |

## Screenshots (committed)

| Viewport | Main — settled | Branch — settled | Branch — mid-doors |
| --- | --- | --- | --- |
| 390 | `before-390-unlock-settled.png` | `after-390-unlock-settled.png` | `after-390-unlock-doors.png` |
| 1024 | `before-1024-unlock-settled.png` | `after-1024-unlock-settled.png` | `after-1024-unlock-doors.png` |
| 1280 | `before-1280-unlock-settled.png` | `after-1280-unlock-settled.png` | `after-1280-unlock-doors.png` |

Capture: `node apps/pages/scripts/capture-lock-v5-evidence.mjs main|branch [outDir]` (requires `PLAYWRIGHT_CHROMIUM` and a fresh `apps/pages` vite build for `branch`).
