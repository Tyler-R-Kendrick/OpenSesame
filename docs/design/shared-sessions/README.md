# Shared sessions — design canvas

The ceremonies and pages for making a session shareable: who is in it, what
each participant can reach, for how long, and how somebody gets in — plus the
transport exposure review that decides what such a channel may carry.

The argument these artboards draw is
[ADR 0079](../../adr/0079-shared-sessions-and-scoped-grants.md). Read that
first; the canvas is the shape it implies, not a second source of truth.

Published canvas:
<https://claude.ai/code/artifact/b6ae93f2-150a-4576-a850-ecfddbc6a6b5>

## Artboards

| File | What it shows |
|------|---------------|
| `Main.dc.html` | **Live.** Share this session, on a 390×844 phone. Pick a person, switch between the whole vault and chosen rows, tick rows, set a role and a TTL, and watch the grant summary change. The `noHost` tweak shows what sharing says on a deployment with no Host — the dependency this feature reintroduces. |
| `Participants.dc.html` | Who is in the session: pending requests above the roster, each participant's scope and remaining life, and the note about what withdrawing a grant does and does not undo. |
| `Invite.dc.html` | The operator's invite (link plus an out-of-band code) beside the recipient accepting it. |
| `JoinRequest.dc.html` | A public session: the stranger asking, and the operator deciding what they get before they are let in. |
| `Exposure.dc.html` | The review, drawn: what may cross the transport, what never may, and the three findings worth arguing with. |
| `canvas.json` | Two pages (Ceremonies, Transport review), layout, sticky notes, launch view. |

## What the copy is grounded in

The key hierarchy (`docs/security/key-hierarchy.md`) for what a grant actually
wraps and why revocation is re-keying; `crates/lifecycle` for the expiry ladder
and its value-blind payload; `packages/claims` for the invite's shape (bearer
link, out-of-band user code, TTL, single use); `policy/openfga/model.fga` for
where row-level authorization has to go. Tokens and components are lifted
verbatim from `apps/pages/src/styles.css`, so these screens sit in the same
vocabulary as the first-run ceremony.

Nothing here is implemented. The ADR is `Proposed` on purpose: the findings are
meant to be argued with before code exists.

## Building and re-seeding

The artboards are **generated**. `_style.css` holds the shared design system
(the app's tokens plus the session vocabulary these screens add);
`parts/*.html` holds only what differs per artboard.

```bash
cd docs/design/shared-sessions
node build.mjs            # parts/*.html + _style.css → *.dc.html
```

Then re-seed and republish to the same artifact URL:

```bash
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out opensesame-shared-sessions.html \
  --title "OpenSesame Shared Sessions" \
  --artboard Main.dc.html --artboard Participants.dc.html \
  --artboard Invite.dc.html --artboard JoinRequest.dc.html \
  --artboard Exposure.dc.html \
  --canvas canvas.json
```

The seeded output is gitignored — it is ~2.4 MB of editor code and is fully
regenerated from the artboards above. Edit `parts/*.html`, never the generated
`.dc.html`, unless you are reconciling an edit somebody made in the canvas
editor (in which case `--extract` the published page first and fold the change
back into the part).
