# PR #2017: the GitHub App remove key arms instead of opening `window.confirm`

Review storage for this pull request. Nothing here is approved yet. The
change is `819b480d3` on `claude/ecstatic-mayer-wbm2c3-native-panels-gate`,
merged into #2017.

## Builds compared

| Side | Commit | What it is |
|---|---|---|
| Before | `a7ac0c862` | `main`: the key asks through `window.confirm` |
| After | `d172e3086` | #2017 head (`claude/ecstatic-mayer-wbm2c3-main-green-ts`): the key is an armed `IconKey` with a keep key beside it |

Both were `VITE_BASE=/OpenSesame/` Pages builds, served by the repository's
static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/` in
headless Chromium. Both ran the same driver,
[capture-remove-key.mjs](capture-remove-key.mjs), with the same
[journey.json](journey.json). A guest switches External connectors on,
opens Connections › GitHub and presses Create GitHub App, so the app runs
its own Manifest flow. Two endpoints are stood in for: github.com's
`settings/apps/new` form, which answers with GitHub's return to the app
carrying a one-time code, and `api.github.com`, which answers the
conversion with a throwaway App ("OpenSesame evidence", owner
"evidence-owner") and a freshly generated RSA key. The app claims the code,
and its Saved app row shows the remove key. The key is then pressed once
(tapped on the phone). Any browser dialog is recorded and dismissed, so the
App is kept.

## Measurements (read from the browser)

| Viewport | Before (`a7ac0c862`) | After (`d172e3086`) |
|---|---|---|
| 1280 × 800, mouse | `window.confirm` fired: "Remove the GitHub App from this device? Its private key and client secret will be deleted." It is a browser dialog, outside the page, so the screenshot cannot show it. In the page, one key, unchanged: "Remove GitHub App from this device", `icon-btn icon-btn--sm`, 24×24 at (598, 426) | No browser dialog. The key reads "Confirm removing the GitHub App from this device", `icon-btn icon-btn--sm is-armed`, 24×24 at (598, 426). "Keep the GitHub App" is 24×24 at (622, 426). Focus is on the armed key. The Saved app row is still drawn |
| 390 × 844, touch | `window.confirm` fired (browser dialog, dismissed). In the page, one key, unchanged, 44×44 at (178, 532) | No browser dialog. Armed key 44×44 at (178, 532). "Keep the GitHub App" 44×44 at (222, 532). Focus is on the armed key |

Before the press, both builds drew one key, "Remove GitHub App from this
device": 24×24 at (598, 426) on desktop and 44×44 at (178, 532) on the phone.

## Files

- [comparison/desktop-sheet.png](comparison/desktop-sheet.png),
  [comparison/phone-sheet.png](comparison/phone-sheet.png): before and after
  side by side, with the readings above.
- [current/](current/): the candidate for `docs/evidence/github-app/pages/web/`.
  It holds the after-state screenshots of the armed key and the slot README
  draft.

## Limits

- The before state is a browser-native dialog. A page screenshot cannot
  show it, so the dialog's type and message are recorded instead.
- GitHub is stood in for at the two endpoints named above. Nothing reached
  github.com or api.github.com.
- The package build script's `tsc --noEmit` was skipped because the host
  killed it for memory. It writes no output. The Tailscale native
  distribution passed `readNativeDistribution` against its pinned digest.
- The hatched mark beside "Install GitHub App" shows in both builds and is
  not part of this change.

## Promotion, after the owner approves

```bash
node scripts/dev/promote-evidence.mjs github-app/pages/web <dir-with-current-files> \
  --source d172e3086d5cf2cfcd0afd7e0f39e599eab1e42d \
  --approved-by <reviewer> --approval-ref <approval-url>
node scripts/quality/evidence-gate.mjs
node scripts/quality/docs-index.mjs
```
