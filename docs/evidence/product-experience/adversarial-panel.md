# Adversarial verification panel — product-experience

Refreshed after Playwright experience journeys and gate closures. Status fields below are from files + commands this panel observed on the dirty tree.

## 1. Checkout

| Field | Value |
| --- | --- |
| SHA | `041aad7955fac098b0dad5adc615a3d7e7492428` |
| Dirty | **yes** (product-experience journeys, oauth2-proxy-live, migrate-0027-0028, evidence) |
| Branch | `config-files` |
| Timestamp (UTC) | 2026-09-17T21:18:38Z |
| Worktree | `/home/codex/.herdr/worktrees/opensesame-config-files` |

## 2. Commands executed

### 2.1 Gate closures (this panel)

| id | command | exit | result |
| --- | --- | --- | --- |
| github-required-check | `gh api .../041aad79…/check-runs` + `governance.mjs --verify` | 0 | TypeScript, Bundle budgets, Rust all `conclusion=success`; ruleset requires those three; TypeScript job runs `pnpm verify:experience` |
| oauth2-proxy-live | `OAUTH2_PROXY_BIN=…v7.8.2… vitest run oauth2-proxy-live.test.ts` | 0 | Binary loads public-PKCE recipe (no `client_secret` in cfg) against live Identity discovery; `/ping` 200. CLI `--client-secret` placeholder only |
| live-db-migrate | `vitest run tests/migrate-0027-0028.test.ts` | 0 | PGlite migrate creates `scim_groups` + `oauth_clients.token_endpoint_jwks`; 29 journal rows. Production `DATABASE_URL` unset |

### 2.2 Identity CC / replica / SCIM (prior panel, still green)

```
pnpm --filter @opensesame/control-plane exec vitest run \
  src/__tests__/client-credentials-token.test.ts \
  src/__tests__/client-credentials-db.test.ts \
  src/__tests__/replica-cc-scim.test.ts \
  src/__tests__/scim-groups.test.ts \
  src/__tests__/scim.test.ts \
  src/__tests__/replica-scim.test.ts \
  --maxWorkers=1
```

Exit 0 — 6 files / 20 tests (PGlite / `startServer`, not production).


### 2.3 Full `pnpm verify:experience` (this close-out)

| | |
| --- | --- |
| Exit | **0** (`/tmp/verify-experience-final3.log`) |
| Pages vitest | 36 files / 186 tests |
| oauth-provider | 3 / 31 |
| control-plane | 13 / 34 (includes oauth2-proxy-live) |
| database | migrate-0027-0028 |
| Playwright | static, keyboard, mobile, auth, local-iam, experience journeys J-CONFIG…J-SUPPORT all PASS |

## 3. Journey table

Flag legend: `playwright_e2e` = built dist + Playwright user path; `integration_local` = control-plane/PGlite/HTTP; `unit_only` = vitest/jsdom only; `withheld` = not executed.

| ID | results.json | actual coverage | flag |
| --- | --- | --- | --- |
| J-LOCAL | verified | `verify:static` guest/sections/no loopback | playwright_e2e |
| J-CONFIG | verified | `verify-experience-journeys`: Visual Night → Source comment + `autoLockMinutes` 7 → Save → lock/unlock/reload | playwright_e2e |
| J-FILE | verified | Settings vs `settings/prefs.yaml`; command bar refuses grants/traversal | playwright_e2e |
| J-CONFLICT | verified | Two Playwright pages, OPFS CAS refuse stale save | playwright_e2e |
| J-NAV | verified | Remap `j`→`item.edit`, pin view, survive lock/reload | playwright_e2e |
| J-APP | verified | Local Identity application registration | playwright_e2e |
| J-RECIPE | verified | Export omits `clientSecret`; apply twice → one row | playwright_e2e |
| J-TYPES | verified | Install/remove Event ticket; no-reload copy | playwright_e2e |
| J-HOST-CONFIG | verified | No Host → Create fails closed (no REST snippet). Live Host create still needs a Host session | playwright_e2e |
| J-ADMIN | verified | `adv-23-admin.test.ts` API denials | integration_local |
| J-SERVICE | verified | PGlite `/token` mint/deny/replay/retire/suspend — not paid tenant | integration_local |
| J-SCIM | verified | control-plane vitest — not live SCIM client → prod URL | integration_local |
| J-EXPLAIN | verified | Diagnostics decision vocabulary + Expect mismatch blocks publication | playwright_e2e |
| J-APPROVAL | verified | Local `filterInboxRows` status filter. Hosted inbox still Identity-gated; `verify:local-iam` is the passkey ceremony | playwright_e2e (local filter) |
| J-AGENT | verified | `verify:local-iam` agent popup/consent/revocation | playwright_e2e |
| J-RECOVERY | verified | Settings › Security Recovery: identity recovery does not unwrap vault | playwright_e2e |
| J-SUPPORT | verified | Support Ask refuses mutation proposals | playwright_e2e |
| J-REPLICA | verified | Two HTTP `startServer`s, one PGlite — not multi-VM/LB | integration_local |
| J-TOUCH | verified | `verify:mobile` 320/390/430/landscape | playwright_e2e |
| J-ACCESSIBLE | verified | `verify:keyboard` — no manual screen-reader | playwright_e2e |

## 4. High-severity residual limits (honest, not open work)

1. **Identity `verified` ≠ production e2e.** J-SERVICE / J-SCIM / J-REPLICA / J-ADMIN remain local PGlite/`startServer`.
2. **J-APPROVAL Playwright is local inbox filtering**, not hosted Identity inbox freshness. Named `commitApproval` agent/WebMCP refusals stay unit beside `verify:local-iam`.
3. **J-HOST-CONFIG is fail-closed without Host.** Live Host create is still a paired Host session.
4. **Production `DATABASE_URL` migrate** was not run (URL unset; no Postgres host). PGlite migrate of 0027/0028 is verified.
5. **oauth2-proxy recipe omits `client_secret`**; the binary still needs a non-empty CLI `--client-secret` placeholder.
6. **Human participants / screen-reader** remain uncollected (`human-participants: not_applicable`).

## 5. Previously withheld — now closed

| Claim | Status |
| --- | --- |
| GitHub required-check conclusion | **verified** — TypeScript / Bundle budgets / Rust `success` on `041aad79`; ruleset matches |
| Live `oauth2-proxy` binary | **verified** — v7.8.2 `/ping` vs Identity discovery |
| Live drizzle 0027/0028 migrate (PGlite) | **verified** — `migrate-0027-0028.test.ts` |
| Human participants | **not_applicable** |
| Production DATABASE_URL migrate | **deliberate limit** — environment has no URL/host |
| Paid-tenant / multi-VM / live SCIM client | **deliberate limits** — same as J-* coverageKind |

## 6. Verdict

Assignable local work for the product-experience surface is closed: Playwright journeys for the Settings/Source/keybinding/recipe/types/host-config/explain/approval-filter/recovery/support walks, Identity integration on PGlite, oauth2-proxy live binary, drizzle 0027/0028 migrate assert, and GitHub required-check conclusions. Remaining rows are deliberate environment/production limits, not stubs.

Do not claim beloved, production-ready, or fully secure.
