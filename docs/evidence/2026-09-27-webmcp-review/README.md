# The WebMCP review no longer claims a reload — 2026-09-27

Two real builds of `apps/pages`, both walked with `journey.json` by
`apps/pages/scripts/capture-evidence.mjs`: the before is this PR's base in the
stack (`c56cb20b`, built in its own worktree and captured with
`EVIDENCE_DIST`), the after is this branch. Each walk starts on an empty
device: *Continue as guest*, Settings › Capabilities, then switch
**WebMCP tools** on and stop at the review, before anything is applied (the
new `propose` capture verb).

| Sheet | Before | After |
|-------|--------|-------|
| [Review, 1280](1280-webmcp-review.png) | reload after enabling: WebMCP tools | reload after enabling: — |
| [Review, 390](390-webmcp-review.png) | reload after enabling: WebMCP tools | reload after enabling: — |

The measurements are the `report` lines the harness printed from the review's
definition list. Every other row reads the same in both builds.

## Why this is the change

This PR teaches the resolver and loader #470's rule: a capability that must
start in a fresh document, approved after the document has already run other
modules, waits (`RELOAD_REQUIRED`, "reload to start"). WebMCP declared
`requiresDocumentReload`, but nothing had ever enforced it, and it was not
true. The required `verify:webmcp` gate chooses WebMCP after boot and reads
four native tools without a reload. Once the rule was enforced, that false
declaration broke the gate. So the declaration was corrected, not the gate:
WebMCP starts in place, and the review stops telling people to reload for it.

`apps/pages/src/lib/capabilities/reload.test.ts` holds the gate's scenario
against the real catalog. A document that has already run modules commits
every optional capability, and none of them waits for a reload. It fails
with the old declaration.

## Not captured

- **reload to start.** With WebMCP corrected, the only capability that needs
  a fresh document is always-on silent sign-in (`identity.ambient-sso`). It
  waits only when the document did not approve it at load, for instance when
  an operator's policy withdrew it and later allowed it again mid-session. No
  guest walk reaches that. Verified by `loader-reload.test.ts` (the loader's
  refusal, before any import), `reload.test.ts` and `status.test.ts` (the
  label).
- **saved offline** (`cached-offline`). It appears only with `selected-only`
  delivery (setup always writes `shell-only`), and only on an approved
  capability that is not running in the document — a running one reads
  `active`. Verified by `worker-controller-saved.test.ts`,
  `store-offline.test.ts` and `status.test.ts`.
