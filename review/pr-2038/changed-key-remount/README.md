# PR #2038: a changed peer key keeps its mark on the join form

Review storage for this pull request. Nothing here is approved yet.

This covers commit `4e788fab1`. A joiner on a new device asks, and the remembered-key
check refuses because the owner's key changed. The ask creates the joiner's
vault first, so the join form mounts again before the check answers. Before
the fix, the refusal reached only the tray. The form came back with Ask to
join enabled and no mark. After the fix, the form row keeps the "This peer's
key changed" mark and Ask to join stays disabled until the peer trust signal
changes.

## Builds compared

| Side | Commit | What it is |
|---|---|---|
| Before | `886185fbe` | PR head before the fix |
| After | `88d2733e1` | PR head with the fix (`4e788fab1`) and the routes-test update (`88d2733e1`) |

Both sides are `VITE_BASE=/OpenSesame/` Pages builds made by
`scripts/lib/ci-pages-build.mjs`, each in its own worktree. Between the two,
only `apps/pages/src/modules/sharing.live/live-hooks.ts` and
`live-join-ask-state.ts` change in the product, plus tests and the walk.

Both sides ran the same driver, [capture-changed-key.mjs](capture-changed-key.mjs),
with the same [journey.json](journey.json). The sheets were composed by
`apps/pages/scripts/capture-evidence.mjs compose`.

## The walk

1. The owner, in a 1280-wide desktop context, seals a PIN vault and keeps one
   login. They switch Live sessions on, start an invite session and copy its
   peer trust signal. The driver uses the repository's walk helpers for this:
   `ownerEnters`, `openLive`, `startSession`, `unfoldPeerTrust` and `copyFrom`.
2. The joiner uses one screen of the journey: a desktop context, or a phone
   context with a coarse pointer. A different peer is already remembered on
   that device, as after an earlier session with another owner. The joiner
   opens the link and gives the code, a name and a PIN for their own vault.
   They paste the owner's signal under Advanced and press Ask to join.
3. The ask creates the joiner's vault, which mounts the form again. The
   remembered-key check then refuses.
4. The driver waits until the tray holds the notice: the bell on a desktop,
   the More menu's mark on a phone. 1.5 s later it reads the form and takes
   the screenshot.

## Measurements (read from the browser)

| Viewport | Before (`886185fbe`) | After (`88d2733e1`) |
|---|---|---|
| 1280 × 800, mouse | Row mark "This peer's key changed" **absent**. Ask to join **enabled**, 40×40 at (280, 511), named "Ask to join". Form marks: Link in hand | Row mark **present**, 20×20 at (280, 511). Ask to join **disabled**, 40×40 at (280, 545), named "Ask to join. This peer's key changed". Form marks: Link in hand, This peer's key changed |
| 390 × 844, touch | Row mark **absent**. Ask to join **enabled**, 44×44 at (16, 629). Form marks: Link in hand | Row mark **present**, 44×44 touch box at (4, 617). Ask to join **disabled**, 44×44 at (16, 663), named "Ask to join. This peer's key changed" |

On both sides and at both widths, the joiner's own vault had been created (no
PIN fields remained), the page was at `/OpenSesame/live`, and the tray held the
notice.

## Files

- [comparison/desktop-sheet.png](comparison/desktop-sheet.png) and
  [comparison/phone-sheet.png](comparison/phone-sheet.png): before and after
  side by side, with the readings above.
- [current/](current/): the after-state screenshots, candidates for
  `docs/evidence/live-join/pages/web/`, with a draft slot README.

## Limits

- Chromium only. Firefox and WebKit were not captured.
- On a phone the mark keeps StatusMark's usual 44 px touch box, centred on the
  glyph, so its box starts at x = 4 inside the 16 px gutter. That is the
  existing StatusMark styling on a coarse pointer. This PR does not change it.
- The owner's session code differs between captures, because each run starts
  its own session.

## Promotion, after the owner approves

```bash
node scripts/dev/promote-evidence.mjs live-join/pages/web <dir-with-current-files> \
  --source 88d2733e1bae125f0ee2a2404cfc4a58c391ffd3 \
  --approved-by <reviewer> --approval-ref <approval-url>
node scripts/quality/evidence-gate.mjs
node scripts/quality/docs-index.mjs
```
