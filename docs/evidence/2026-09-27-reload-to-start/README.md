# WebMCP switched on mid-session reads "reload to start" — 2026-09-27

Two real builds of `apps/pages`, both walked with `journey.json` by
`apps/pages/scripts/capture-evidence.mjs`. The before is this PR's base in the
stack (`c56cb20b`, built in its own worktree); the after is this branch. Each
walk starts on an empty device: *Continue as guest*, then Settings ›
Capabilities, then switch **WebMCP tools** on and apply the review.

WebMCP registers the page's tools with the browser. Its descriptor says
`requiresDocumentReload`, so it has to start in a fresh document. By the time
a guest reaches Settings, the page has already run other modules. Before this
change, the plan approved WebMCP and nothing said it could not start in
place: the switch read on, and the tile showed no mark. After this change,
the plan keeps it approved with `RELOAD_REQUIRED` (carried from #470's
restart-required rule), the lifecycle reads `reload-required`, the loader
refuses it before any import, and the tile wears a warn mark labelled
**reload to start**. What a document approved while it was still clean still
starts as usual; the store records that set as `approvedAtLoad`, so a vault
opening mid-boot cannot strand it.

| Sheet | Before | After |
|-------|--------|-------|
| [WebMCP tile, 1280](1280-webmcp-enabled.png) | switch on; 0 status marks on the tile | switch on; 1 mark, `aria-label="reload to start"` |
| [WebMCP tile, 390](390-webmcp-enabled.png) | 0 status marks | 1 mark (`reload to start`) |

Measurements are the `count` lines the harness printed from the browser:
`[role="switch"][aria-checked="true"][data-capability-title="WebMCP tools"]`
(1 in both builds) and
`li.conn-tile:has([data-capability-title="WebMCP tools"]) .status-mark[aria-label="reload to start"]`
(0 before, 1 after).

Not captured: **saved offline**, the per-capability `cached-offline` status
from the same PR. It appears only when the installation's delivery is
`selected-only`, and the worker has answered `OFFLINE_READY` for the plan.
The setup road always writes `shell-only`, so a guest walk cannot reach it.
It is verified instead by `worker-controller-saved.test.ts` (what counts as
saved), `store-offline.test.ts` (the lifecycle, projected without a resolve)
and `status.test.ts` (the label).
