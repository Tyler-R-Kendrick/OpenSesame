# Usability

Human participant testing was not collected in this session. Do not treat this file as interviews or satisfaction scores.

Deterministic task evidence that did run:

- Visual/Source round-trips, alias resolution, keybinding import refusal, saved-view scope isolation (`apps/pages` configuration tests).
- ADV-01..36 each have a runnable test on shipped functions or the owning Identity/Hosted adapter (`adv-matrix.test.ts`, `adv-matrix-rest.test.ts`, oauth-provider, control-plane SCIM/LDAP/admin).
- J-LOCAL: built Pages under `/OpenSesame/` with no Host/Identity; guest visits every section; zero loopback requests (`verify:static`).
- J-CONFIG / J-FILE / J-CONFLICT / J-NAV / J-APP / J-RECIPE / J-TYPES / J-HOST-CONFIG / J-EXPLAIN / J-APPROVAL (local filter) / J-RECOVERY / J-SUPPORT: Playwright against built `/OpenSesame/` dist via `verify-experience-journeys.mjs` (password-sealed vault where lock/unlock matters).
- J-TOUCH: 320/390/430/landscape/tablet coarse-pointer contract (`verify:mobile`).
- Keyboard-only load, guest, section travel, unlock, local IAM ceremonies (`verify:keyboard`). Manual screen-reader validation was not performed.
- J-AGENT local grants: `verify:local-iam`.
- Identity J-SERVICE / J-SCIM / J-REPLICA / J-ADMIN: PGlite / `startServer` integration (not production).
- oauth2-proxy v7.8.2 live `/ping` vs Identity discovery; PGlite drizzle 0027/0028 migrate assert; GitHub required checks success on baseline SHA.
- Human participants remain uncollected (`not_applicable`).

Protocol for if participants become available: occasional personal/family user, source-first homelab operator, application/organization administrator, agent/workload developer. Observe task completion, errors, recovery, and ability to explain a denial. Collect no real secrets.
