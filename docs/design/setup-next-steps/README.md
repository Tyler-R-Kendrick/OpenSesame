# Setup: what comes after the question — design canvas

Three things an operator may do once first-run setup has asked its one
question: point OpenSesame at a model that can drive a website's own
password-reset form, invite somebody, and register another device. None of
them is required, and none of them is a step.

Also here, because the invite ceremony is where it becomes visible: the rule
that a share link and the access it carries are **two clocks**, and that the
link can never be the longer one.

Published canvas:
<https://claude.ai/code/artifact/8264a9b4-0264-4fcb-90e0-68cdf07ebe0a>

## The design decision, stated up front

[ADR 0078](../../adr/0078-external-idp-is-the-identity-service.md) cut setup to
one screen and one question, and `docs/design/first-run-setup/` records the
progress rail being built and then removed as furniture — its page-2 artboard
is titled *Model A — built, then outgrown*. Three optional steps could put that
rail straight back.

They do not have to, because these are not steps **of** setup. They are things
to do **after** it, and the difference is the whole design: a board of offers
rather than a rail, with no counter, no back, no Skip link, and no order. Doing
nothing and pressing the commit is already a complete path.

`WhyABoard.dc.html` draws the rejected stepper fairly beside the board so the
choice can be overruled rather than assumed.

## Artboards

| File | What it shows |
|------|---------------|
| `Main.dc.html` | **Live.** The board, on a 390×844 phone. Tap a card to see it configured and tap again to see it unset — what changes is the state line, which names what is *lost* by not setting the thing up rather than counting what is left to do. |
| `Models.dc.html` | Choosing who runs the model. The browser's own on-device model first, then a model server on this machine, then hosted ones below a fold — ordered by how far the redacted page travels. |
| `Invite.dc.html` | Inviting somebody: who, what they may do, how long the link lasts, how long their access lasts. |
| `Devices.dc.html` | Registering a device: a short-lived pairing code, and what a device does and does not get. |
| `WhyABoard.dc.html` | Stepper versus board, with the case for each. |
| `ModelBoundary.dc.html` | What crosses to the model provider, what structurally cannot, and why — plus how far the page travels on each plane, and the residual risk the setup step must not pretend away. |
| `LinkLife.dc.html` | The two clocks, their defaults and ceiling, and what expiry does and does not undo. |
| `canvas.json` | Three pages (the board and its sheets, why a board, what is at stake), layout, sticky notes, launch view. |

## What the copy is grounded in

[ADR 0076](../../adr/0076-autonomous-web-login-rotation.md) §1 for the model's
tool surface — `fill_credential(ref, selector)` names *which* credential and
*where* and never *what*; there is no `read_field_value` and no `get_secret`;
redaction happens at capture rather than at render, because a redaction applied
when a transcript is displayed is not redaction. `ModelBoundary.dc.html` is
that section drawn.

[ADR 0083](../../adr/0083-browser-plane-inference-fallback.md) for the browser
plane and for the bypass rule the Models sheet states in its last line: skipping
resolves to the device's own model where the browser carries one that can be
shown a page, and to nothing where it cannot. Never to a download — the top rung
is the only fallback, and the two rungs below it are offers with their cost
named. `apps/pages/src/lib/browser-inference.ts` is that ladder;
`apps/pages/src/lib/model-provider.ts` is the rule.

[ADR 0079](../../adr/0079-shared-sessions-and-scoped-grants.md) §3 for the
seven-day ceiling and for refusing an over-long lifetime rather than clamping
it; `crates/domain/src/shared_session.rs` for `MAX_GRANT_LIFETIME` and
`MIN_GRANT_LIFETIME`, which are what the access picker's ends are. `packages/claims`
for the invite's existing shape: bearer link, out-of-band code, TTL, single use.

Tokens and components are lifted verbatim from `apps/pages/src/styles.css` and
from the two sibling canvases, so these screens sit in the same vocabulary as
the first-run and shared-session ceremonies. The `.go` ink square is the
terminal commit on every sheet, per [`docs/design/controls.md`](../controls.md).

## The numbers, and why those

| Clock | Default | Range | Why |
|-------|---------|-------|-----|
| Share link | 24 hours | 15 min – 7 days | Long enough to reach somebody in another timezone without a second attempt; short enough that a link forwarded into a group chat is dead by the next morning. The default is a Settings value, so an organization that wants an hour can have one. |
| Access it carries | 8 hours | 1 min – 7 days | The ceiling is `MAX_GRANT_LIFETIME`. There is no "forever" to pick because the field that would hold it does not exist. Something longer than a handover is a membership, which is a more visible thing to be. |
| Device pairing code | 10 minutes | fixed | A device being paired is in your hand. |

The link's options are clamped to the access lifetime: set access to an hour
and the 24-hour and 7-day link options go away. Not a validation error after
the fact — the option is not there, so the invite that would arrive dead cannot
be composed.

## Building and re-seeding

The artboards are **generated**. `_style.css` holds the shared design system
and `parts/<Name>.html` holds only what differs; `build.mjs` stamps the two
together into each committed `<Name>.dc.html`.

```bash
cd docs/design/setup-next-steps
node build.mjs
```

## What is implemented

The models path is built, in Settings → Connectivity rather than on the board —
the board itself is still a design. `ModelProviderPanel` carries the sheet's
list and its ordering, the capability ladder and the bypass rule, and reports at
the top of the panel what is running *right now*, which with nothing configured
may well be the browser's own model.

The invite and device sheets, the board, and the link/access two-clock picker
are not implemented.
