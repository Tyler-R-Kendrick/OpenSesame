# Ceremonies into Pages

The plan behind [ADR 0140](../../adr/0140-pages-hosts-every-ceremony.md):
every ceremony `apps/ceremonies`, `apps/mobile-mfa` and `apps/console` served
becomes a Pages route over one implementation in `@opensesame/ceremony-kit`
and `@opensesame/app-core`, and the three apps are deleted.

## Inventory

| App › flow | API | Pages / app-core before | Status |
|---|---|---|---|
| ceremonies `/` index | — | `screens/FrontDoor.tsx` | covered; route dropped |
| ceremonies `/claim#token=osc_clm_` (ownership claim, guest path) | `POST /v1/claims/present`, `GET /v1/claims/:id`, `POST /v1/claims/:id/complete`, `POST /v1/principals/provisional` | model: `app-core/lib/claims/` (step 4) | partial: no route (step 8) |
| ceremonies `/claim#token&key` (drop) | `POST /v1/claims/present` | `screens/DropClaimScreen.tsx`, `app-core/lib/vault/drop.ts` | partial: optional capability, fragment not scrubbed on arrival (step 8); refusals worded by code (step 4) |
| ceremonies `/guest` | provisional principal | `guest-auth.ts` `continueAsGuest` | covered (D12) |
| ceremonies `/device?user_code=`, console `/device` | `POST /v1/device/approve` | `DevicesPanel` via `app-core/lib/directory.ts` | partial: no deep link, optional enterprise capability, three implementations |
| ceremonies `/delegate#token=osc_dlg_` | Host delegations present/claim | Join (`lib/join/invite.ts`) | covered by Join (D5) |
| ceremonies `/inbox` | `GET /v1/authorization-requests?status=pending`, approve/deny | Access › Requests (local only) | missing |
| ceremonies `/approve/:ref` | request, requirement, activation, decision, report | none | missing |
| ceremonies `/notifications` | channels, bindings, preferences | none | missing |
| ceremonies `/invoke/:kind` + `.well-known` | — (parser) | none | missing |
| mobile-mfa `/i/<ref>` | interaction resolve/read/activation/approve/deny, WebAuthn | none | missing |
| mobile-mfa legacy links (`?user_code=`, `?code=`, `opensesame://invoke/mfa`, `opensesame-mfa://approve`) | `/v1/device/approve` | device approval, no adapter | partial |
| mobile-mfa enrolment | `/v1/mfa/passkey/*`, `/v1/mfa/totp/*` | vault authenticator only (ADR 0091) | missing (D10) |
| mobile-mfa token field | — | Identity session | dropped (D13) |
| console `/` sign-in | OIDC, `/v1/federated/providers` | `SignInPanel` | covered |
| console `/claim` | as ceremonies `/claim` | none | missing (second copy) |
| console `/task-access` | Host task read | CLI / MCP | not moved (D4) |
| console `/organization` | organizations, domains, SCIM tokens | Identity › Organizations (create, members) | partial |

## Placement

| Flow | Route | Logic | Capability |
|---|---|---|---|
| Claim + drop | `/claim` (fragment `key` → drop, else claim) | `app-core/lib/claims/` | `identity.ceremonies` (route leaves `sharing.drops`) |
| Device approval | `/device?user_code=` | ceremony-kit `approveDevice`; `directory.ts` delegates | `identity.ceremonies` |
| Interaction approval | `/i/:ref` | ceremony-kit `interaction-approval.ts`; app-core `lib/interactions.ts` | `identity.ceremonies` |
| Legacy links | → `/device` or refusal | ceremony-kit | `identity.ceremonies` |
| Approval review | `/approve/:ref` | ceremony-kit `authorization-request-client.ts`, `approval-copy.ts`; app-core `lib/approvals.ts` | `identity.ceremonies` |
| Inbox | Access › Requests rows (`plane: "hosted"`) | as above | `access.authority` |
| Authenticator hand-off | `/invoke/:kind` | ceremony-kit `authenticator-invocation.ts` | `identity.ceremonies` |
| Notification routing | Settings › Notifications | app-core `lib/notification-routing.ts` + a `VirtualFileProvider` | `notifications.routing` (optional) |
| Account factors | Settings › Security rows | app-core `lib/account-factors.ts` | `identity.federation` |
| Organization sign-in | Identity › Organizations (new files) | app-core `lib/org-signin.ts` | `enterprise.directory-provisioning` |
| `/guest`, `/delegate` | aliases | — | `identity.ceremonies` |

`identity.ceremonies` gets ADR 0130's five additions: an `alwaysOn` descriptor
(`IDENTITY_API_EGRESS`, `browserPermissions: ["webauthn"]`), the module
`apps/pages/src/modules/identity.ceremonies/runtime.ts`, ownership and
classification rules (plus `.well-known/**`), the operation mapping, and a
profile fixture proving `minimal-local` resolves its routes.
`notifications.routing` gets the same, with a fixture proving its absence from
`minimal-local`.

## References that change

- **Link origin:** `packages/control-plane/src/config.ts` `OPENSESAME_CLIENT_APP_URL` is the one ceremony origin; claim `verificationUri` uses `${clientAppUrl}/claim` when set (the server-rendered `/v1/claims/:id/verify` stays as the zero-JS fallback); discovery's `consoleOrigin` follows.
- **Drops:** `VITE_OPENSESAME_CEREMONIES` goes; `pagesClaimBase()` only.
- **CORS / env:** ceremonies `:5181` and `OPENSESAME_CONSOLE_ORIGIN` go; association variables move to the Pages section of `.env.schema`.
- **`mfaAppUrl`:** retired from settings, runtime config, the deploy workflow, settings files and WebMCP settings tools.
- **`.well-known`:** `write-authenticator-associations.mjs` moves to `apps/pages/scripts/`, run from the Vercel build only (D11).
- **Scripts, budgets, baselines, design lint:** root `dev` and `quality:bundle` filters, `tools/quality/bundle-budgets.json`, `quality-baseline.json` entries, `design-lint.mjs` roots, `task-security-battle-test.sh`.
- **Docs:** AGENTS.md, READMEs, ADRs 0062/0086/0133, the native-host plan, the weekly agent-surface routine. Audits stay as history.

## Pull requests

Every one passes lint, `lint:design`, `quality`, typecheck and tests; route
PRs also `build:profile`, `verify:capability-graph`, `verify:static`,
`verify:keyboard`, `verify:mobile`, and carry before/after evidence.

1. ADR 0140 and this plan.
2. `spec/config/ceremony-routes.json`, ceremony-kit builders and drift tests; the authenticator-link parser moves into ceremony-kit.
3. One device approval (ceremony-kit `approveDevice`; `directory.ts` delegates).
4. Claim model in app-core (tests ported from console and ceremonies); drop error codes merged.
5. Interaction-approval model from mobile-mfa.
6. Approvals, notification routing, account factors, org sign-in models.
7. `identity.ceremonies` and `/device`; legacy adapters.
8. `/claim` dispatcher; boot-time capture; `sharing.drops` loses the route.
9. `/i/:ref`, `/approve/:ref`, hosted rows in Access › Requests.
10. `/invoke/:kind` and the `.well-known` writer.
11. `notifications.routing` and account-factor rows.
12. Organization sign-in panels.
13. Aliases and config (link origin, CORS, env, `mfaAppUrl`).
14. Delete `apps/ceremonies`, `apps/mobile-mfa`, `apps/console` and every reference.
