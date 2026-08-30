# Identity — people, providers, devices

Design contract for the Pages **Identity** section. Decision records:
[ADR 0060](../adr/0060-identity-screen-idp-brokering.md) (screen, ceremony),
[ADR 0061](../adr/0061-access-pam-plane-ceremonies.md) (Devices tab, My
access, prose purge). Parity target and terminology:
[`docs/competitors/tailscale-identity.md`](../competitors/tailscale-identity.md).
Sibling contract (shared hard rules):
[`docs/design/access-screen.md`](access-screen.md).

Identity is the person plane: who vouches for people, which devices they
use, and the access they hold. It does — it never lectures.

## Hard rules

Same as Access: **no prose** (headers, actions, one-line empty states),
**a ceremony per fork** (add IdP, approve device, claim access, unlink
identity — each its own focused view, one at a time), nothing that isn't
identity management.

## Layout

Route `/identity`, nav label **Identity** (`IconUser`), crumb `identity`.
Tabs, one mounted at a time:

**People · Providers · Devices · Service accounts · Organization**

The first-navigation **IdP ceremony gate** from ADR 0060 is unchanged
(branded first-class row + custom-OIDC two-step + "Set up later"), minus its
explanatory paragraphs.

## People — who can sign in, and what they hold

- **Me card** — principal id (truncated, copyable), state badge
  (`provisional → Guest`, `active`, `suspended`, `closed`), assurance chip,
  created date. No sentences beyond the chips.
- **Linked identities** (`GET /v1/principals/identities`) — kind icon,
  issuer, display hint, assurance; **Unlink** (confirm →
  `DELETE /v1/principals/identities/:id`).
- **My access** (the requester side of JIT) — grants I hold
  (`GET /api/v1/delegations`, claimant rows): resource, actions, mode,
  expiry countdown; **Drop** (confirm → `DELETE /api/v1/delegations/{id}`).
  Primary action **Claim access** → ceremony: paste `claim_token` +
  `user_code` → present (`POST /api/v1/delegations/present`) shows the
  offered scope → **Accept** (`POST /api/v1/delegations/claim`,
  `accepted_item_ids` = all items) → grant appears in My access.
- **Org members** (active org profile) — rows with role chips
  (owner/admin/member); owner adds by principal id, changes roles, removes.

## Providers — multiple IdP sources

The registry this device brokers. Adding is always a ceremony, repeatable
for any number of providers. The ceremony's primary path is **bindable auth
providers** — enterprise SSO, not social-login buttons:

- **Provider presets** (each its own tailored form, all riding ADR 0055's
  shipped BYO registration — they are OIDC issuers):
  - **WorkOS** (AuthKit): issuer is fixed `https://api.workos.com` — client
    id + secret only.
  - **Okta**: Okta domain (`dev-123.okta.com`, `.oktapreview.com`) → issuer
    `https://<domain>` — + client id/secret.
  - **Auth0**: tenant or custom domain → issuer `https://<domain>` — +
    client id/secret.
  - **Better Auth**: deployment base URL is the issuer (OIDC-provider
    plugin) — + optional client id/secret (DCR when offered).
- **Custom OIDC** — the generic issuer card (unchanged).
- **Sign-in providers** — the branded first-class row from the catalog,
  secondary (they bind too, but they are not the point of this screen).

Registry records carry an optional `providerType` (`workos` | `okta` |
`auth0` | `better-auth`); rows badge it ("WorkOS", "Okta", …) with a
monogram tile instead of the generic "Custom OIDC" badge. Row actions:
**Sign in** (brokered leg), **Remove** (local mirror; one-line operator
note).

- **Register an IdP** → the ceremony. Works repeatedly; the registry never
  caps.
- Empty (post-dismissal): `No identity provider registered.` + **Register
  an IdP**.

## Devices — approve what signs in (Tailscale: Device approval)

Moved from the deleted Authority screen. The browser-reachable device act:

- **Approve a device** ceremony — enter the user code the device/CLI shows
  → `POST /v1/device/approve` `{user_code}` → result line (approved /
  unknown code / unreachable). Focused field, one submit.
- One-line note: connected devices are enumerated by the operator, not here
  (no browser-reachable list route exists — honest, not faked).

## Service accounts — identities that aren't people

OAuth clients (`GET /v1/oauth/clients`): name, client id, mode, state,
created. **Create** (ceremony: display name, redirect URIs, sector
identifier → `POST /v1/oauth/clients`), **Rotate** (`POST /:id/rotate` →
new client id shown once, copy), **Revoke** (confirm → `POST /:id/revoke`).
Empty state: `No service identities.`

## Organization — the tailnet analog

Membership cards (slug, display name, my role, SSO/SAML issuer as the
server-side IdP binding). **Create an organization** ceremony (slug
validated `ORG_SLUG_RE`, display name, optional SSO issuer →
`POST /v1/organizations`; server errors surface plainly). SCIM/LDAP stay
operator/API surface (ADR 0056) — not edited here, no paragraph explaining
them.

## Data and state rules

- Existing libs stay the binding points: `lib/directory.ts` (people, orgs,
  OAuth clients), `lib/idp-registry.ts` (providers), `lib/access.ts`
  delegation functions (My access + claim — same seams Access uses).
- New: `approveDevice(userCode)` in `lib/directory.ts` →
  `POST /v1/device/approve` — exact shape from
  `apps/control-plane/src/routes/device.ts` (read it before binding).
- Guests/no-session → connect notes, not errors. All lists fail soft.

## Test plan

Extend `IdentitySection.test.tsx` (hoisted seam mocks):

- Devices: approve posts `{user_code}`; unknown-code and unreachable paths
  render their one-liners.
- My access: claimant delegations render with expiry; Drop confirms then
  calls seam; Claim ceremony — present shows offered scope, accept posts
  `{claim_token, user_code, accepted_item_ids}` and the grant appears.
- Providers: registering a second and third IdP works (registry appends,
  no re-gate).
- Prose budget: no multi-sentence paragraphs in any view.
- Lib tests for `approveDevice` (wire mapping, error mapping).

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome — all green before reporting.
