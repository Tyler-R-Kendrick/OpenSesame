# Ceremonies into Pages

The plan behind [ADR 0140](../../adr/0140-pages-hosts-every-ceremony.md):
every ceremony `apps/ceremonies`, `apps/mobile-mfa` and `apps/console` served
becomes a Pages route over one implementation in `@opensesame/ceremony-kit`
and `@opensesame/app-core`, and the three apps are deleted.

## Inventory

| App › flow | API | Pages / app-core before | Status |
|---|---|---|---|
| ceremonies `/` index | — | `screens/FrontDoor.tsx` | covered; route dropped |
| ceremonies `/claim#token=osc_clm_` (ownership claim, guest path) | `POST /v1/claims/present`, `GET /v1/claims/:id`, `POST /v1/claims/:id/complete`, `POST /v1/principals/provisional` | `/claim` route (`identity.ceremonies`, `ClaimRoute`, `gate: "any"`) over `app-core/lib/claims/` — the model (step 4), the boot-time capture `arrival.ts` and the route's `route-model.ts` (step 8) | covered in Pages; the apps' copies go with them (step 14) |
| ceremonies `/claim#token&key` (drop) | `POST /v1/claims/present` | `/claim` opens a drop itself: `modules/identity.ceremonies/DropClaimScreen.tsx` (loaded lazily inside the module) over `app-core/lib/claims/drop-open.ts`, always-on (D2); sending stays in `sharing.drops` (`vault/drop.ts`, `vault/drop-transport.ts`). The fragment leaves the address at boot and the key is held in memory only (step 8) | covered |
| ceremonies `/guest` | provisional principal | `guest-auth.ts` `continueAsGuest` | covered (D12) |
| ceremonies `/device?user_code=`, console `/device` | `POST /v1/device/approve` | `/device` route (`identity.ceremonies`, `gate: "any"` since step 8) and `DevicesPanel`, one form (`DeviceApproval`) over `app-core/lib/device-approval.ts` → `directory.ts` → ceremony-kit (step 7) | covered in Pages; the two apps' copies go with them (step 14) |
| ceremonies `/delegate#token=osc_dlg_` | Host delegations present/claim | Join (`lib/join/invite.ts`) | covered by Join (D5) |
| ceremonies `/inbox` | `GET /v1/authorization-requests?status=pending`, approve/deny | Access › Requests: `sections/access/HostedRequestsPanel.tsx` (`access.authority`, loaded only where an Identity API is configured) draws app-core `lib/approvals.ts`' hosted rows beside the local ones; every row opens `/approve/:ref`, none decides inline (step 9) | covered in Pages; the app's copy goes with it (step 14) |
| ceremonies `/approve/:ref` | request, requirement, activation, decision, report | `/approve/:ref` route (`identity.ceremonies`, `gate: "any"`, before unlock, D7): `ApproveScreen.tsx` / `ApproveReview.tsx`, loaded only on the route, over ceremony-kit `approval-review.ts` and app-core `lib/approvals.ts`; the link is read at boot by ceremony-kit `readApprovalArrival` (`app-core/lib/approvals-link.ts`) (step 9) | covered in Pages; the app's copy goes with it (step 14) |
| ceremonies `/notifications` | channels, bindings, preferences | Settings › Notifications, the optional `notifications.routing` capability in the Notifications feature (D9): `modules/notifications.routing/` (the category, its panel and one routing session) over app-core `lib/notification-routing/` (step 6, plus `policy.ts`: a preference that adds a channel policy refused is refused before it is sent) and `sections/settings/notification-routing-files.ts` — `settings/notifications/routing.json` (written by the Form and the file viewer through one road), read-only `channels.json` and `bindings.json` (ADR 0134). Gated on a configured Identity API; with none it shows the inbox alone (step 11) | covered in Pages; the app's copy goes with it (step 14) |
| ceremonies `/invoke/:kind` + `.well-known` | — (parser; nothing is fetched) | `/invoke/:kind` route (`identity.ceremonies`, `gate: "any"`, before unlock): `InvokeScreen.tsx`, loaded only on the route, over ceremony-kit `readInvocationArrival` → `parseAuthenticatorInvocation`; the handle leaves the query at boot and is held in memory (`app-core/lib/invoke-link.ts`, `invoke-route.ts`). The app link is a key the person presses; an MFA user code also offers `/device`, through the device link's own hand-off. `.well-known` associations: `apps/pages/scripts/write-authenticator-associations.mjs`, paths derived from the spec, run from the Vercel build only (D11) (step 10) | covered in Pages; the app's copy goes with it (step 14) |
| mobile-mfa `/i/<ref>` | interaction resolve/read/activation/approve/deny, WebAuthn | `/i/:ref` route (`identity.ceremonies`, `gate: "any"`, before unlock, D7): `InteractionScreen.tsx`, loaded only on the route, over ceremony-kit `interaction-approval.ts` and app-core `lib/interactions.ts`; the link's fragment and credential query leave at boot (`app-core/lib/interactions-link.ts`) (step 9) | covered in Pages; the app's copy goes with it (step 14) |
| mobile-mfa legacy links (`?user_code=`, `?code=`, `opensesame://invoke/mfa`, `opensesame-mfa://approve`) | `/v1/device/approve` | normalised to `/device` at boot by app-core `lib/device-link.ts` over ceremony-kit `readInteractionArrival`; `?code=` only on `/device`, never the sign-in callback at the base (step 7) | covered |
| mobile-mfa enrolment | `/v1/mfa/passkey/*`, `/v1/mfa/totp/*`, `GET /v1/mfa/factors`, `DELETE /v1/mfa/factors/:id` (step 11b) | Settings › Security › *Your account*: one row per account passkey and for the authenticator app, one action each, enrolled and removed in the one sheet (`security/AccountFactorsPanel.tsx`, `AccountFactorCeremony.tsx`) over app-core `lib/account-factors.ts`; drawn only with an Identity API and a session (D10, step 11b) | covered in Pages; the app's copy goes with it (step 14) |
| mobile-mfa token field | — | Identity session | dropped (D13) |
| console `/` sign-in | OIDC, `/v1/federated/providers` | `SignInPanel` | covered |
| console `/claim` | as ceremonies `/claim` | the `/claim` route (step 8) | covered in Pages; the console's copy goes with it (step 14) |
| console `/task-access` | Host task read | CLI / MCP | not moved (D4) |
| console `/organization` | organizations, domains, SCIM tokens | Identity › Organizations (create, members); model: app-core `lib/org-signin.ts` (step 6) | partial: no panels (step 12) |

## Placement

| Flow | Route | Logic | Capability |
|---|---|---|---|
| Claim + drop | `/claim` (fragment `key` → drop, else claim) | `app-core/lib/claims/` (claim model, `drop-open.ts`); sending a drop stays in `sharing.drops` | `identity.ceremonies` (route and the recipient side left `sharing.drops`, step 8, D2) |
| Device approval | `/device?user_code=` | ceremony-kit `approveDevice`; `directory.ts` delegates | `identity.ceremonies` |
| Interaction approval | `/i/:ref` | ceremony-kit `interaction-approval.ts`; app-core `lib/interactions.ts` | `identity.ceremonies` |
| Legacy links | → `/device` or refusal | ceremony-kit | `identity.ceremonies` |
| Approval review | `/approve/:ref` | ceremony-kit `authorization-request-client.ts`, `approval-review.ts`, `approval-copy.ts`, `approval-words.ts`; app-core `lib/approvals.ts` | `identity.ceremonies` |
| Inbox | Access › Requests rows (`plane: "hosted"`) | as above | `access.authority` |
| Authenticator hand-off | `/invoke/:kind`; `.well-known/**` on Vercel | ceremony-kit `authenticator-invocation.ts`, `invocation-link.ts` | `identity.ceremonies` (route and `.well-known/**`, step 10) |
| Notification routing | Settings › Notifications | app-core `lib/notification-routing/` + `sections/settings/notification-routing-files.ts` (a `VirtualFileProvider`) | `notifications.routing` (optional, step 11) |
| Account factors | Settings › Security rows (*Your account*, beside the vault's keys) | app-core `lib/account-factors.ts` over the Identity API's `GET /v1/mfa/factors` (display-safe: kind, opaque id, created) and `DELETE /v1/mfa/factors/:id` (the caller's own only), added in step 11b; registry `identity.account_factors.{list,enroll,remove}` | `identity.federation` (covered, step 11b) |
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
- **`mfaAppUrl`:** retired from settings, runtime config, the deploy workflow, settings files and WebMCP settings tools (done, step 11b; the passkey note's Mobile MFA QR went with it).
- **`.well-known`:** `write-authenticator-associations.mjs` moves to `apps/pages/scripts/`, run from the Vercel build only (D11); the SPA rewrite in `apps/pages/vercel.json` excludes `/.well-known/` (done, step 10; the apps/ceremonies copy goes in step 14).
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
