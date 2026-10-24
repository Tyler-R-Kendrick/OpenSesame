# Security sheet: a guest's first key leads on to the scan

What this slot shows: Settings › Security in the Pages app, after a guest
presses Add on the Authenticator app row, chooses "Use a PIN instead", and
sets a PIN. The sheet stays open and moves on to step 2, Scan
([ADR 0091](../../../../adr/0091-account-exits-and-unlock-ceremony.md)).

| File | Viewport | Measured in the browser |
|---|---|---|
| [scan-step-desktop.png](scan-step-desktop.png) | 1280 × 800, mouse | `[role=dialog]` count 1, box 424×800 at (856, 0); current rail step `.steps__seg.is-now .steps__label` = "2 · Scan" |
| [scan-step-phone.png](scan-step-phone.png) | 390 × 844, touch (phone context, DPR 3) | `[role=dialog]` count 1, box 390×616 at (0, 229); current rail step = "2 · Scan" |

On the base build (`e17991f70`), walked the same way, the same reads gave
`[role=dialog]` count 0 at both widths: the sheet closed after Set PIN and the
guest was back on Security with the PIN enrolled and no scan. That comparison
stays on the pull request; it is not kept here.

## Source

- Implementation commit: `8431be4f5` (branch
  `claude/ecstatic-mayer-wbm2c3-auth-rail`, PR #2045). The change is
  `cd172001a` (`useOpenVaultKey` keys the unlocked shell per opened vault),
  with `8431be4f5` keying it by the decoy actor too.
- Base for the comparison: `e17991f70` (`origin/main` at the time).

## Method

- `VITE_BASE=/OpenSesame/` Pages build of that commit, served by the
  repository's static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/`
  in headless Chromium (`/opt/pw-browsers/chromium`).
- `apps/pages/scripts/capture-evidence.mjs capture after <journey>` with the
  steps: `guest`, `visit settings/security`, `settle 3000`,
  `pressIn [.sw--method:has-text("Authenticator app"), Add]`,
  `press Use a PIN instead`, `fill PIN` and `fill Confirm PIN` (48291037, the
  walks' PIN), `press Set PIN`, `settle 15000`, then `count`, `report` and
  `measure` before the shot. The same journey captured the base build.
- The build ran `security-profile.mjs`, `vite build` and `build-workers.mjs`
  directly. The package script's `tsc --noEmit` step was skipped because the
  host killed it for memory. It writes no output, so the files in `dist` are
  the same either way. The pinned Tailscale native distribution was finished
  outside the build: the pinned zopfli compressor ran past its 60 s limit on
  a loaded host. Before the Vite build used that distribution,
  `readNativeDistribution` checked it against the pinned manifest digest
  `8f773e22…`.
- Uncropped viewport screenshots. Nothing in the page was hidden or arranged
  by hand.

## Checks

- The capture walked to the Scan step with no harness failure at both widths.
- The QR code holds the setup key of a throwaway guest vault. That vault
  existed only in a headless browser context, and the context was closed
  after the capture.
- Not run for this capture: `verify:auth`, the unit test
  `app-root.open-vault.test.tsx`, and the other gates. Those belong to the
  pull request's CI.

## Approval

Recorded in `manifest.json` by `scripts/dev/promote-evidence.mjs` when the
owner approves these captures. The capture alone does not approve them.
