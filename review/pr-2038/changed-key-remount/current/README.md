# Live join: a changed peer key keeps its mark on the join form

This slot shows a joiner's join form in the Pages app after their first ask
was refused because the owner's key changed. The ask created the joiner's own
vault, and the form mounted again. The row keeps a "This peer's key changed"
StatusMark, and Ask to join stays disabled until the peer trust signal
changes. The refusal also sits in the tray
([ADR 0163](../../../../adr/0163-failures-live-in-the-tray.md)).

| File | Viewport | Measured in the browser |
|---|---|---|
| [changed-key-desktop.png](changed-key-desktop.png) | 1280 × 800, mouse | Row mark "This peer's key changed" 20×20 at (280, 511). Ask to join disabled, 40×40 at (280, 545), named "Ask to join. This peer's key changed". Address `/OpenSesame/live` |
| [changed-key-phone.png](changed-key-phone.png) | 390 × 844, touch (phone context, DPR 3) | Row mark 44×44 touch box at (4, 617). Ask to join disabled, 44×44 at (16, 663). Address `/OpenSesame/live` |

## Source

- Implementation: PR #2038, branch
  `claude/ecstatic-mayer-wbm2c3-live-named-candidates`. The fix is
  `4e788fab1`. Captured from `88d2733e1`, the PR head at capture time.
- Base for the comparison: `886185fbe`.

## Method

- A `VITE_BASE=/OpenSesame/` Pages build, served by the repository's
  static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/`,
  in headless Chromium (`/opt/pw-browsers/chromium`).
- Two browser contexts. The owner context used the repository's walk helpers
  to seal a PIN vault, keep one login, switch Live sessions on and start an
  invite session, then copied its peer trust signal. The joiner context
  remembered a different peer first. It then opened the link and gave the
  code, a name, a PIN for its own vault and the signal, and asked. The shot
  was taken 1.5 s after the tray held the notice.
- Uncropped viewport screenshots of the joiner's page.

## Approval

`scripts/dev/promote-evidence.mjs` records approval in `manifest.json` when
the owner approves these captures. The capture alone does not approve them.
