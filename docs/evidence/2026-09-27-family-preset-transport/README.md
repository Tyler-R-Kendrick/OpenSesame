# The Family preset fills the transport Household sharing needs — 2026-09-27

Two real builds of `apps/pages` walked by `journey.json` with
`apps/pages/scripts/capture-evidence.mjs`: the before is `main`'s
`presets.ts`, `capabilities-ports.ts` and `CapabilityDraft.ts`; the after is
this branch. Both start on an empty device: *Set up your own* →
*Customize this installation* → *Family*, then *Save on this device* opens
the review.

Family pre-ticks Household sharing and Secret drops. Household sharing needs
a `transport`, and Secret drops is its only option. Before, the preset left
that slot unset, so the review refused to apply until a person clicked the
one option there was. The gap was found by carrying #470's preset → plan pact
forward (`apps/pages/src/lib/capabilities/presets.pact.test.ts`).

| Sheet | Before | After |
|-------|--------|-------|
| [Household sharing card, 1280](1280-family-cards.png) | transport choices pressed: 0 of 1 | 1 of 1 (Secret drops) |
| [Review, 1280](1280-family-review.png) | 1 conflict (`sharing.household` needs a choice for slot `transport`); enables Secret drops; Apply disabled | 0 conflicts; enables Secret drops, Household sharing; Apply enabled |
| [Household sharing card, 390](390-family-cards.png) | pressed: 0 of 1 | pressed: 1 of 1 |
| [Review, 390](390-family-review.png) | 1 conflict | 0 conflicts |

The measurements are the `count` / `report` lines the harness printed from the
browser (`.capcard__alts [aria-pressed="true"]`, `[aria-label="Conflicts"] li`,
the review's text).
