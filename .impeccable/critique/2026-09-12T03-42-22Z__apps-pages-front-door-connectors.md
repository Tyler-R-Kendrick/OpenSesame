---
target: apps/pages (FrontDoor, setup › connectors, Access › Connectors)
total_score: 102
max_score: 150
na_heuristics: 
p0_count: 1
p1_count: 10
timestamp: 2026-09-12T03-42-22Z
slug: apps-pages-front-door-connectors
---
# The front door, setup › connectors, Access › Connectors

Critique of the three surfaces ADR 0115 adds, run on the production build
served under the GitHub Pages origin at 1280 and 390 (captures in
`apps/pages/.impeccable/review/front-door-*`, `setup-connectors-*`,
`access-connectors-*`). Assessment A was the isolated design-review agent;
Assessment B was `impeccable detect` over the touched files. Scores are as
found, before the fix batch below.

## Design Health Score

Five dimensions per surface, ten points each.

| Surface | Hierarchy | Consistency | Copy | States | Accessibility | Total |
|---|---|---|---|---|---|---|
| Front door | 7 | 8 | 6 | 7 | 8 | 36/50 |
| Setup › connectors | 6 | 6 | 5 | 7 | 8 | 32/50 |
| Access › Connectors | 7 | 7 | 5 | 7 | 8 | 34/50 |
| **Total** | | | | | | **102/150** |

## Design Specificity Verdict

**LLM assessment:** Unmistakably this product. The door is the unlock card
with a hero on top — divider, brand bar, full-width guest, `Skip` in the
corner — and the reel is the one authored moment. The connector surfaces
wear the ceremony card and the Access row grammar. Where it slipped it
slipped toward *explaining*: four-line ledes, hints restating ledes, prose in
a tab whose contract is "no prose", and one uppercase-tracked heading the
type rules forbid outright.

**Deterministic scan:** 0 anti-patterns. Advisories only: the door's
`clamp(1.75rem, 8vw, 2.6rem)` off the type ramp (now recorded in DESIGN.md
as the one display step), and pre-existing brand-mark colours and
`0.6875rem` labels in `unlock.css` / `setup.css` that predate this change.

**Visual overlays:** Not injected; findings were taken from the fourteen
captures and the source.

## Overall Impression

The arrival is right: a first visitor sees the wordmark, two roads and every
way in, with nothing in front of anything. What the review found was
finish, not structure — copy that narrates the layout it sits on, teal spent
on rows that are not selected, and two phones' worth of wrapping (`Bind`
orphaned under chips, tab strips folding to two rows).

## What's Working
- The unlock card as the door's body: divider, brand bar, guest, local
  seal, `Skip` — ungated, whole (AGENTS.md §5).
- Wordmark as `h1` with the visually-hidden name and `aria-hidden` reels;
  reduced motion settles; the door lands on the first road and yields to an
  input caret where an Identity API exists.
- `.go` + verb in the setup foot and `.btn--primary` inside the stack — both
  patterns where controls.md puts them.
- Access rows: mark, `h3`, `integration · connection id`, `Authorized` /
  `N errors` / `N bound` chips; one bind form under one row; the rail's
  Grants count and the row's `bound` count moving together (one ledger).
- Empty, busy, error and success states each in the shared vocabulary
  (`role="alert"`, `role="status"`, `aria-busy`).

## Priority Issues

Fixed in the same change unless marked otherwise.

- **[P0] Access carried two educational hints in a "no prose" tab** —
  `ConnectorDirectoryForm` gained `terse`; Access keeps six words on the
  endpoint ("Only listings are read — never a token.") and nothing on the key.
- **[P1] Every synced card wore `is-on`** — plain `xcard`; the chips carry
  the state.
- **[P1] `.ways__head` uppercase and tracked** — sentence case, untracked.
- **[P1] Setup lede and endpoint hint duplicated each other** — two-line
  lede, one-sentence hints, the trailing hint cut to one line.
- **[P1] Bind success rendered as a bare `<output>` sentence** — `StatusNote`
  tone `ok`, placed after the directory line.
- **[P1] Revoke on a binding asked nothing while Grants confirms** —
  *recorded, not changed*: a binding is the Identity-share ledger's grant and
  that panel's Revoke asks nothing either; sessions and application grants
  confirm because they are authority in use. Written into
  `docs/design/access-screen.md`.
- **[P1] `Bind` orphaned under the chips at 390; two `Bind`s while binding** —
  ≤30rem grid puts the verb beside the name; the row's `Bind` steps aside
  while its form is open.
- **[P1] Road names off-baseline; lede narrated the layout** — rows anchor
  to the top, the setup kind is one line, the lede is one sentence.
- **[P1] The reel replayed on every gate mount** — once per session
  (`wordmarkSeams`); the ceremony and the rail arrive still.
- **[P1] Placeholder repeated the fill chip** — `https://…`; the chip is the
  one offer.
- **[P1] Access tabs wrapped to two rows at 390** — one scrolling hairline.
- **[P2] Rail labels truncated beside a tab strip naming the same six** —
  only the current step's label is read.
- **[P2] Support key abutted `Skip` in the setup foot** — the foot clears it.
- **[P2] `directory` chip on every row** — shown only with mixed sources.
- **[P2] Directory line mixed a code block and a chip** — one mono line with
  middots.
- **[P2] Brand-mark buttons ~40px at 390** — the 44px floor.
- **[P2] Bind form autofocused under a touch pointer** — gated on a fine
  pointer.

## Persona Red Flags
Jordan (first visit): the old lede explained the screen instead of the
choice. Sam (keyboard): nothing — Tab order matched the ADR before and
after. Riley (phone): `Bind` two rows down, tab strips folding, a 40px
brand mark.

## Questions to Consider
- When the Host is configured too, should Access › Connectors merge the
  two sources into one list (as now) or keep the directory's rows apart?
- Is `a few optional steps` the kind a first visitor needs beside
  `Set up your own`, or should the road name the first tab it opens?
