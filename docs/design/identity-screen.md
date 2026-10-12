# Identity — people, providers, devices

Design contract for the Pages **Identity** section. Decision records:
[ADR 0060](../adr/0060-identity-screen-idp-brokering.md) (screen, ceremony),
[ADR 0061](../adr/0061-access-pam-plane-ceremonies.md) (Devices tab, My
access, prose purge). Parity target and terminology:
[`docs/research/competitors/tailscale-identity.md`](../research/competitors/tailscale-identity.md).
Sibling contract (shared hard rules):
[`docs/design/access-screen.md`](access-screen.md).

Identity is the person plane: who vouches for people, which devices they
use, and the access they hold. It does — it never lectures.

## Hard rules

Same as Access: **no prose** (headers, actions, one-line empty states),
**a ceremony per fork** (add IdP, approve device, unlink identity — each its
own focused view, one at a time), nothing that isn't identity management.

## Layout

Route `/identity`, nav label **Identity** (`IconUser`), crumb `identity`.
Tabs, one mounted at a time:

**People · Agents · Providers · Devices · Applications · Organizations**

Each tab is contributed by a capability and is on the page only while that
capability is (`apps/pages/src/sections/identity/identity-views.ts`). With no
Identity API configured, or for a guest, People, Agents, Applications and
Organizations are the vault's own encrypted local records
(`LocalDirectoryPanel`); the sections below describe the panels backed by the
Identity API, drawn once one is configured.

The **IdP ceremony** from ADR 0060 (branded first-class row + custom-OIDC
two-step + "Set up later") is no longer a gate on first navigation: it is opened
from Providers, replaces the tab panels while it is open, and "Set up later"
closes it.

## People — who can sign in, and what they hold

- **You card** — principal id (truncated, copyable), state mark
  (`provisional → Guest`, `active`, `suspended`, `closed`), assurance chip,
  created date. No sentences beyond the chips.
- **Linked identities** (`GET /v1/principals/identities`) — kind icon,
  issuer, display hint, assurance; **Unlink** (confirm →
  `DELETE /v1/principals/identities/:id`).
- **Org members** (active org profile) — rows with role chips
  (owner/admin/member); owner adds by principal id, changes roles, removes.

## Providers — multiple IdP sources

OpenSesame itself is always the first row: **OpenSesame (this device)** —
the device-native Identity host (ADR 0118). Additional upstreams are
optional. Adding one is always a ceremony, repeatable for any number of
providers. The ceremony's primary path is **bindable auth providers** —
enterprise SSO, not social-login buttons:

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
monogram tile instead of the generic "Custom OIDC" badge. Row actions for
additional upstreams: **Sign in** (brokered leg), **Remove** (local
mirror; one-line operator note). The device IdP has neither — it is not
removable and does not federate out.

- **Register an IdP** → the ceremony for an *additional* upstream. Works
  repeatedly; the registry never caps.
- Never an empty Providers list: the device IdP always vouches. Do not
  show copy like "No identity provider registered."

## Devices — approve what signs in (Tailscale: Device approval)

Moved from the deleted Authority screen. The browser-reachable device act:

- **Approve a device** ceremony — enter the user code the device/CLI shows
  → `POST /v1/device/approve` `{user_code}` → result line (approved /
  unknown code / unreachable). Focused field, one submit.
- Drawn only where an Identity API is configured and a session exists; with
  no session the tab shows a connect note instead.

### The tailnet's machines (ADR 0169)

With `networking.tailnet-devices` in the plan, Devices leads with the
**Tailnet devices** panel: every machine Tailscale reports, read through the
daemon the page is paired with, waiting ones first. A row is the machine's
short name, first address, OS · client version · owner · tags, and
`StatusMark`s for what needs someone (waiting, key expired or expiring,
routes waiting, update, tailnet lock). Its keys: ✓ approve (waiting only),
✎ settings (a sheet: name, tags, approved, key expires, one switch per
advertised subnet route, exit node; saves only the diff), ⏱ expire key and
🗑 remove, both armed by the first press with a keep beside them. The head
carries + Add a device (a sheet that mints an auth key and shows it and its
`tailscale up` command once), reload, and forget the pairing. Under it, the
Auth keys panel (revoke, armed) and Activity (what changed, by which
pairing, accepted or refused). A `read` pairing draws the same lists with no
change keys. Unpaired, the panel's only key pairs; on the shared-origin demo
there is no key and the mark says why (ADR 0158), and Add is drawn only once
the daemon has a tailnet. Under it all, the browsers that opened this vault
(rename, remove); nothing is typed in by hand.

## Applications — identities that aren't people

The hosted panel is *OIDC applications*: OAuth clients
(`GET /v1/oauth/clients`) as rows — name, client id, admission mode, state,
created. **Create** (ceremony: display name, redirect URIs, sector
identifier → `POST /v1/oauth/clients`), **Rotate** (`POST /:id/rotate` →
new client id shown once, copy), **Revoke** (`POST /:id/revoke`). Empty state:
`No applications registered.` (The route and view id are still
`service-accounts`.)

## Organizations — the tailnet analog

Membership cards (slug, display name, my role, SSO/SAML issuer as the
server-side IdP binding). **Create an organization** ceremony (slug
validated `ORG_SLUG_RE`, display name, optional SSO issuer →
`POST /v1/organizations`; server errors surface plainly). SCIM/LDAP stay
operator/API surface (ADR 0056) — not edited here, no paragraph explaining
them.

## Data and state rules

- The binding points are in `packages/app-core/src/lib/`: `directory.ts`
  (people, orgs, OAuth clients), `idp-registry.ts` (providers) and
  `device-approval.ts` (the Devices form, over ceremony-kit's `approveDevice`
  and `POST /v1/device/approve` — shape in
  `packages/control-plane/src/routes/device.ts`).
- Guests/no-session → connect notes, not errors. All lists fail soft.

## Test plan

Extend `IdentitySection.test.tsx` (hoisted seam mocks):

- Devices: approve posts `{user_code}`; unknown-code and unreachable paths
  render their one-liners.
- Providers: registering a second and third IdP works (registry appends,
  no re-gate).
- Prose budget: no multi-sentence paragraphs in any view.
- Lib tests for `approveDevice` (wire mapping, error mapping).

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome — all green before reporting.
