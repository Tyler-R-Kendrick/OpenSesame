# Sharp corners, no red controls, one way out

Before/after for three DESIGN.md rules, now linted: corners are square, a control is never red, and a
sheet has one way out. Two real builds (the base before this change, and this
branch), the same walk — seal a vault, lock it, press "Reset this browser?" —
at desktop 1280 and phone 390 (coarse pointer). Every number is read from the
browser by the journey's `measure` and `style` steps.

| Sheet | Before | After |
|---|---|---|
| [1280 × 800](1280-reset-sheet.png) | erase square `rgb(179, 36, 36)`; three keys (Close, Erase, Keep it); corners 2px | erase square `rgb(23, 23, 23)`; two keys (Close, Erase); corners 0px |
| [390 × 844](390-reset-sheet.png) | red erase square; three 44×44 keys; 2px corners and a rounded sheet top | ink erase square; two 44×44 keys; 0px corners and a square sheet top |

The journey is [`journey.json`](journey.json); it re-runs with
`apps/pages/scripts/capture-evidence.mjs` (see `skills/visual-evidence`).
