# Access › Connectors lists what Connections configures — 2026-09-27

Two real builds of `apps/pages` (base `2338c69c`, and this branch) walked by
`journey.json` with `apps/pages/scripts/capture-evidence.mjs`, as a guest, no
Host, no Identity API. Each journey first saves a Git remote on
Connections › Git (a device-local connector), then opens Access › Connectors.

| Sheet | Before | After |
|-------|--------|-------|
| [Connector page (Resend), 1280](1280-resend-page.png) | 3 panels: Vercel Connect, Create connector, **Access** | 2 panels: Vercel Connect, Create connector |
| [Access › Connectors, 1280](1280-access-connectors.png) | 0 connector rows; the Nango directory form | 1 row, Git (any remote): Bind, Configure, Open in Connections |
| [Binding it, 1280](1280-access-bind.png) | nothing to bind (0 selects) | Identity, Policy, Duration (3 selects) |
| [Access › Connectors, 390](390-access-connectors.png) | 0 connector rows | 1 row |

Measurements are the `count` / `report` lines the harness printed from the
browser (`main h2`, `#local-connectors .identity-row`, `#local-connectors select`).
