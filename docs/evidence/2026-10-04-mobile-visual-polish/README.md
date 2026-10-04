# Mobile visual polish — 2026-10-04

Two real builds (base `0d975968`, this branch), walked the same way by
`apps/pages/scripts/capture-evidence.mjs`; numbers are read from the browser.

| Sheet | Before | After |
|-------|--------|-------|
| [`390-capabilities.png`](390-capabilities.png) | switch keys at x = 330 and 317 (two edges, 13px apart); a long capability name clipped to one line with an ellipsis | every switch at x = 317, one edge; long names wrap to two lines |
| [`390-password.png`](390-password.png) | update key on a line of its own (top 412), reveal/copy at 391 | reveal, copy and update all at top 370, one line |
| [`1280-capabilities.png`](1280-capabilities.png) | rail + panel | identical |

Also fixed and held by new `verify:mobile` contracts (`scripts/lib/phone-polish.mjs`):
top-bar prompt keeps its lock key whole at 320px, search keys carry no chrome,
an add-a-field chip sits at its own width.

Desktop regression check: nine screens at 1280 × 800 (vault, saved login,
Settings general/security/vaults/capabilities, Access requests/resources,
Settings connections) captured on both builds and compared with pixelmatch.
Eight are pixel-identical; the saved login differs by 360px, all on its
randomly generated username line.
