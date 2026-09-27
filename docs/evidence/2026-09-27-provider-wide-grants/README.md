# Access › Connectors lists provider-wide grants — 2026-09-27

Two real builds of `apps/pages` walked by `journey.json` with
`apps/pages/scripts/capture-evidence.mjs`: the before is #536's head, and the
after is this branch. Both are a guest session with no Host and no Identity
API. The journey saves a Git remote on Connections › Git, then grants
*Git (any remote)* to `guest-1` on Access › Grants. That share is keyed by
the provider id, the same shape as every standing grant. Finally the journey
opens Access › Connectors.

| Sheet | Before | After |
|-------|--------|-------|
| [Access › Connectors, 1280](1280-access-connectors.png) | 1 row, `0 bound`, no binding listed | 1 row, `1 bound`: guest-1 · Use · `all Git (any remote)` |
| [Access › Connectors, 390](390-access-connectors.png) | `0 bound` | `1 bound`; the chip and Revoke wrap within the row |

The measurements are the `count` / `report` lines the harness printed from the
browser (`#local-connectors .identity-row`, `#local-connectors .access-binding`).
