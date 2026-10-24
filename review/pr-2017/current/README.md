# GitHub App: the remove key arms before it removes

What this slot shows: Connections › GitHub in the Pages app with a GitHub
App registered from this browser, after one press of "Remove GitHub App from
this device". The key arms, a keep key appears beside it, and no browser
dialog opens. A second press removes the App, which deletes its sealed
private key and client secret. The keep key disarms and returns focus
(DESIGN.md, armed keys).

| File | Viewport | Measured in the browser |
|---|---|---|
| [armed-remove-desktop.png](armed-remove-desktop.png) | 1280 × 800, mouse | "Confirm removing the GitHub App from this device", `icon-btn icon-btn--sm is-armed`, 24×24 at (598, 426); "Keep the GitHub App" 24×24 at (622, 426); focus on the armed key; no browser dialog |
| [armed-remove-phone.png](armed-remove-phone.png) | 390 × 844, touch (phone context, DPR 3) | Armed key 44×44 at (178, 532); "Keep the GitHub App" 44×44 at (222, 532); focus on the armed key; no browser dialog |

## Source

- Implementation: `819b480d3`, captured from `d172e3086` (head of PR #2017).
- Base for the comparison: `main` `a7ac0c862`. There, one press opened
  `window.confirm`.

## Method

- `VITE_BASE=/OpenSesame/` Pages build, served by the repository's
  static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/`
  in headless Chromium.
- A guest switched External connectors on and registered a GitHub App
  through the app's own Manifest flow. github.com's form and
  `api.github.com` were stood in for, and the conversion returned a
  throwaway App with a fresh RSA key. The key was then pressed once.
- Uncropped viewport screenshots.

## Approval

Recorded in `manifest.json` by `scripts/dev/promote-evidence.mjs` when the
owner approves these captures. The capture alone does not approve them.
