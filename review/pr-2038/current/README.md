# Live join: the joiner answers the owner's addresses before connecting

What this slot shows: a joiner's screen in the Pages app right after they
paste the owner's reply and press Connect, where that reply names one of the
owner's addresses (here `127.0.0.1`, which the owner named in Routes). The
join stops at an address step ([ADR 0150](../../../../adr/0150-live-sessions-browser-to-browser.md)
§6, amended 2026-10-24). The step has an Allow key (`.go`) and a "Join
without them" icon key. The browser checks no address until the joiner
answers.

| File | Viewport | Measured in the browser |
|---|---|---|
| [address-step-desktop.png](address-step-desktop.png) | 1280 × 800, mouse | `#live-addresses` 960×113 at (280, 220), text "Owner's address 127.0.0.1"; `.go` "Allow the owner's addresses" 40×40 at (280, 293); `.icon-btn` "Join without them" 32×32 at (550, 297); focus on `#live-addresses-allow`; status mark "The owner's browser names its addresses"; address `/OpenSesame/live` |
| [address-step-phone.png](address-step-phone.png) | 390 × 844, touch (phone context, DPR 3) | `#live-addresses` 358×117 at (16, 283); `.go` Allow 44×44 at (16, 356); `.icon-btn` "Join without them" 44×44 at (290, 356); focus on `#live-addresses-allow`; address `/OpenSesame/live` |

After Allow, the walk reached "Joined Team" at both widths and landed on
`/OpenSesame/vault` with the "1 shared item from the owner's session" notice.

## Source

- Implementation: PR #2038, branch
  `claude/ecstatic-mayer-wbm2c3-live-named-candidates`. Captured from
  `dd4251b56`, the PR head at capture time. It holds the address-step work
  through `ceb40f8c1` plus a merge of `origin/main` `a7ac0c862`.
- Base for the comparison: `e17991f70`. Nothing under
  `apps/pages/src/modules/sharing.live` or `packages/app-core/src/lib/live`
  changed between it and `a7ac0c862`.

## Method

- `VITE_BASE=/OpenSesame/` Pages build, served by the repository's
  static-origin harness as `https://tyler-r-kendrick.github.io/OpenSesame/`.
  The browser was headless Chromium (`/opt/pw-browsers/chromium`) with
  `--allow-loopback-in-peer-connection`. Local network access was granted
  per origin, as in `verify-live-local-pair.mjs`.
- Two browser contexts connected over real WebRTC. The drive used the
  repository's own walk helpers (`live-join-walk.mjs`). The owner context
  (`ownerEnters`, then `startSession`, which names 127.0.0.1 in Routes)
  sealed a PIN vault, kept one login, switched Live sessions on and started
  an invite session. The joiner context (`joinerAsks`, then
  `ownerAdmitsByHand`) opened the link, gave the code and asked. The owner
  compared the session SAS and let them in. The joiner pasted the reply and
  pressed Connect. The shot was taken 800 ms after the step or a later
  status appeared.
- Uncropped viewport screenshots of the joiner's page.

## Approval

Recorded in `manifest.json` by `scripts/dev/promote-evidence.mjs` when the
owner approves these captures. The capture alone does not approve them.
