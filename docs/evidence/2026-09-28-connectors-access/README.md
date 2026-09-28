# Access lists access; Connections imports — 2026-09-28

Two real builds of `apps/pages` (base `38cf0c11`, and this branch) walked by
`journey.json` with `apps/pages/scripts/capture-evidence.mjs`, as a guest, no
Host, no Identity API.

The Nango-compatible directory is a stand-in: the harness answers
`https://api.nango.dev/integrations` and `/connections` with
[`directory/integrations.json`](directory/integrations.json) and
[`directory/connections.json`](directory/connections.json) (two connectors,
GitHub and Slack). No request left the browser for the real service.

| Sheet | Before | After |
|-------|--------|-------|
| [Access › Connectors, 1280](1280-access-empty.png) | Directory endpoint + Environment key + Sync connectors | 9 rows: the vault's standing provider-wide grants to the support agent, each revocable; one Add key |
| [Add, nothing configured, 1280](1280-access-add-nothing.png) | no Add key | "No connectors configured"; New connector → `/connections#catalog` |
| [Connections › Import, 1280](1280-connections-import.png) | no Import key | Import from: Nango (directory), Vercel Connect (team) |
| [Connections after the import, 1280](1280-connections-imported.png) | Nothing connected (0 rows) | `api.nango.dev · 2 connectors` (2 rows) |
| [Add after the import, 1280](1280-access-add-choices.png) | 0 choices | 2 choices + New connector |
| [Access › Connectors, 390](390-access-empty.png) | the directory form | standing grants listed; one Add key |
| [Connections after the import, 390](390-connections-imported.png) | Nothing connected | 2 imported rows |
| [Add after the import, 390](390-access-add-choices.png) | 0 choices | 2 choices + New connector |

Measurements are the `count` / `report` lines the harness printed from the
browser: `#connected-imported .conn-service` (0 → 2),
`[aria-label='Choose a connector'] button` (0 → 2), and the text of
`#local-connectors`.
