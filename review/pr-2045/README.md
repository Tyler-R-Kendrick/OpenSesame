# PR #2045: the Security sheet goes on to Scan after a guest's first key

Review storage for this pull request. Nothing here is approved yet.

## Builds compared

| Side | Commit | What it is |
|---|---|---|
| Before | `e17991f70` | `origin/main`, the merge-base when the PR was captured |
| After | `8431be4f5` | PR head at capture time: the fix `cd172001a`, plus `8431be4f5`, which also starts a fresh shell for a decoy actor (#2071) |

Both were `VITE_BASE=/OpenSesame/` Pages builds, served by the repository's
static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/` in
headless Chromium. Both captures used the same journey
([journey.json](journey.json)) through `apps/pages/scripts/capture-evidence.mjs`:
the guest Skip, Settings › Security, a 3 s settle, Add on Authenticator app,
"Use a PIN instead", PIN 48291037 twice, Set PIN, then a 15 s settle before
the reads. Both sides were captured again on 2026-10-24 for `8431be4f5`.

An earlier after-side capture from `aa12f0388` gave the same readings. Its
screenshots differ from these only in the wordmark's random cipher reels and
in the QR code, which encodes a fresh random setup key on every run.

## Measurements (read from the browser)

| Viewport | Before (`e17991f70`) | After (`8431be4f5`) |
|---|---|---|
| 1280 × 800, mouse | `[role=dialog]` count 0. The sheet closed. The PIN row shows ✓ and Authenticator app still shows + | `[role=dialog]` count 1, box 424×800 at (856, 0). `.steps__seg.is-now .steps__label` = "2 · Scan" |
| 390 × 844, touch | `[role=dialog]` count 0. The sheet closed. The PIN row shows ✓ and Authenticator app still shows + | `[role=dialog]` count 1, box 390×616 at (0, 229). Current step = "2 · Scan" |

Before Set PIN, both builds read "1 · Key" at both widths.

## Files

- [comparison/desktop-sheet.png](comparison/desktop-sheet.png),
  [comparison/phone-sheet.png](comparison/phone-sheet.png): before and after
  side by side, with the readings above.
- [current/](current/): the candidate for `docs/evidence/security-unlock/pages/web/`.
  It holds the two after-state screenshots and the slot README draft.

## Limits

- The package build script's `tsc --noEmit` was skipped because the host
  killed it for memory. It writes no output.
- The pinned Tailscale native distribution was finished by hand after the
  pinned zopfli step went past its 60 s limit on a loaded host. It passed
  `readNativeDistribution` against the pinned manifest digest.
- The QR code holds the setup key of a throwaway guest vault. That vault
  existed only in a headless browser context, which was closed afterwards.

## Promotion, after the owner approves

```bash
node scripts/dev/promote-evidence.mjs security-unlock/pages/web <dir-with-current-files> \
  --source 8431be4f531ad0ef7d36831034a10f0b58671452 \
  --approved-by <reviewer> --approval-ref <approval-url>
node scripts/quality/evidence-gate.mjs
node scripts/quality/docs-index.mjs
```
