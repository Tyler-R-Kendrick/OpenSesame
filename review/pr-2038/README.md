# PR #2038: the joiner answers the owner's addresses before connecting

Review storage for this pull request. Nothing here is approved yet.

## Builds compared

| Side | Commit | What it is |
|---|---|---|
| Before | `e17991f70` | `origin/main` before the PR. The live code is unchanged through `a7ac0c862` |
| After | `dd4251b56` | PR head at capture time (the address step is `ceb40f8c1`, plus a merge of main) |

Both sides ran the same driver, [capture-address-step.mjs](capture-address-step.mjs),
with the same [journey.json](journey.json). The driver uses the repository's
walk helpers in two Chromium contexts over real WebRTC. The owner names
127.0.0.1 in Routes and starts an invite session. The joiner asks, the owner
compares the SAS and lets them in, and the joiner pastes the reply and
presses Connect. The readings come from the joiner's page 800 ms after the
address step or a later status appeared. The driver's imports expect it to
sit in `work/evidence/live-join/pages/web/` of a checkout with the after
commit's `apps/pages/scripts`. Point `EVIDENCE_DIST` at the build under test.

## Measurements (read from the browser)

| Viewport | Before (`e17991f70`) | After (`dd4251b56`) |
|---|---|---|
| 1280 × 800, mouse | `#live-addresses` absent. The joiner was already at `/OpenSesame/vault` with "1 shared item from the owner's session". The join went straight through, with no step. Focus: the "New item" link | `#live-addresses` 960×113 at (280, 220), "Owner's address 127.0.0.1". `.go` "Allow the owner's addresses" 40×40 and `.icon-btn` "Join without them" 32×32. Focus: `#live-addresses-allow`. Mark: "The owner's browser names its addresses". Address: `/OpenSesame/live` |
| 390 × 844, touch | `#live-addresses` absent. The joiner was already at `/OpenSesame/vault`. Focus: the Sections nav | `#live-addresses` 358×117 at (16, 283). `.go` Allow 44×44 at (16, 356) and `.icon-btn` "Join without them" 44×44 at (290, 356). Focus: `#live-addresses-allow` |

After Allow, the after build reached "Joined Team" at both widths and landed
on `/OpenSesame/vault` with the shared-item notice.

## Files

- [comparison/desktop-sheet.png](comparison/desktop-sheet.png),
  [comparison/phone-sheet.png](comparison/phone-sheet.png): before and after
  side by side, with the readings above.
- [current/](current/): the candidate for `docs/evidence/live-join/pages/web/`.
  It holds the two after-state screenshots and the slot README draft.

## Limits

- The package build script's `tsc --noEmit` was skipped because the host
  killed it for memory. It writes no output. The Tailscale native
  distribution passed `readNativeDistribution` against its pinned digest.
- Chromium joiner only. `verify:live-join`'s Firefox and WebKit joiners were
  not run here.

## Promotion, after the owner approves

```bash
node scripts/dev/promote-evidence.mjs live-join/pages/web <dir-with-current-files> \
  --source dd4251b56f32add49ecc0f052e39531c499655f0 \
  --approved-by <reviewer> --approval-ref <approval-url>
node scripts/quality/evidence-gate.mjs
node scripts/quality/docs-index.mjs
```

## Further evidence

- [changed-key-remount/](changed-key-remount/): the join form keeps a changed
  peer key's mark after the ask that creates the joiner's vault mounts it
  again (`886185fbe` → `88d2733e1`).
