# Tailscale — Identity (competitor reference)

Craft bar for the Pages **Identity** screen ([ADR
0060](../adr/0060-identity-screen-idp-brokering.md), design spec
[`docs/design/identity-screen.md`](../design/identity-screen.md)). Where the
[Border0+Tailscale PAM capture](border0-tailscale-pam.md) grades the Access
screen, this capture grades identity: how Tailscale binds a tailnet to an IdP,
and how it manages the people, service identities, groups, and roles that IdP
vouches for.

Sources: tailscale.com docs (linked per section). Claims we could not verify
from text sources are flagged.

## 1. The IdP binding is front-loaded and mandatory

Tailscale is deliberately **not** an IdP: "there are no Tailscale passwords."
Every tailnet is bound to an identity provider at creation time; signup with
email+password is unsupported
([identity docs](https://tailscale.com/docs/integrations/identity)).

First-run ceremony ([quickstart](https://tailscale.com/docs/how-to/quickstart)):

1. **"Sign up with your identity provider"** page — first-class buttons for
   Apple, Google, GitHub, Microsoft, Okta, OneLogin, plus **"Sign up with
   OIDC"** (custom) and **"Sign in with a passkey"** (join-only; a passkey can
   never *create* a tailnet). Exact button labels/branding unverified from
   text sources.
2. SSO consent — Tailscale requests the minimum: email, name, photo URL.
   MFA is delegated to the IdP entirely.
3. Business/Personal use question → add-first-device pages → land in the
   admin console as the tailnet's first user and **Owner**.

The binding is sticky: the tailnet's identity name derives from the domain
(`example.com`) or public email (`user@gmail.com`, `user.github`) and the
domain-derived **Legacy ID cannot be changed once created**. Switching the IdP
later is an Owner-only, beta, constrained operation (**User management →
Identity Provider → ⋯ → "Switch identity provider"**; GitHub and Apple
tailnets can't migrate at all; shared-domain tailnets can't self-serve)
([switch IdP](https://tailscale.com/docs/integrations/identity/switch-identity-provider)).

### Custom OIDC — exact configuration surface

([custom OIDC docs](https://tailscale.com/docs/integrations/identity/custom-oidc))

- Domain-ownership proof via **WebFinger**:
  `https://{domain}/.well-known/webfinger` must map the email domain to the
  issuer.
- Required inputs: **Email address**, **Issuer** (auto-fetched via a
  `Get OIDC Issuer` button), **Client ID**, **Client secret**.
- Required scopes: `openid profile email`. Optional prompt: `none|consent|
  login|select_account`.
- Callback URL to register at the IdP:
  `https://login.tailscale.com/a/oauth_response`.
- Flow: enter admin email → fetch issuer → client credentials → **"Sign up
  with OIDC"** → provider consent → back to the console as Owner.
- Caveats: IdP must be publicly reachable; **SCIM is not supported for custom
  OIDC**; all users of a domain share one IdP.

## 2. Users page

Per-row: avatar, name, email, **role**, **status badges**, **last seen**
(full column list/order unverified). Search by name/email; filters
`status:invited`, `status:needsapproval`
([user approval](https://tailscale.com/docs/features/access-control/user-approval)).

**States:** active · `status:invited` (open invite) · **Needs approval** ·
**Suspended** · **Idle** (>7 days no sign-in, non-Owner).

**Roles (7):** `Owner` (exactly one), `Admin`, `Member` (default; no console),
plus Standard+ tiers `Billing admin`, `IT admin` (users/machines; can grant
any role, even above itself — deliberate two-person rule), `Network admin`
(policy/DNS only), `Auditor` (read-only). Full permission matrix:
[user roles](https://tailscale.com/docs/reference/user-roles). Role change:
row ⋯ → **"Edit role"**; you cannot change your own role.

**Invites:** domain auto-join for custom-domain tailnets (matching email
domain just logs in); **"Invite external users"** by email with a batch role;
shareable one-time invite link (30-day expiry); resend/delete; invitees sign
in with *their own* IdP or passkey — not necessarily yours
([invite any user](https://tailscale.com/docs/features/sharing/how-to/invite-any-user)).

**User approval:** when on, new users land in `needs approval` — they reach
the coordination server but cannot connect to devices. Default **on** for
tailnets created after 2025-05-22. Mutually exclusive with SCIM provisioning.

**Offboarding cascades, documented inline:** suspend freezes devices, tokens,
and console access (restorable); delete purges device keys from the
coordination server and kills API tokens/auth keys, usually within seconds
([remove team members](https://tailscale.com/docs/features/sharing/how-to/remove-team-members)).

## 3. Service identities (three distinct kinds — do not conflate)

- **PAM Service accounts** (beta, PAM settings page): machine identities with
  PAM-scoped roles (`Administrator`, `Member`, `Service Manager`,
  `Read Only`). Create: **"Add service account"** → name → description → role.
  Credentials are **named tokens with lifetimes** (expiring recommended),
  copied once. Every Tailscale **tag** auto-appears as a service account with
  the `client` role
  ([PAM service accounts](https://tailscale.com/docs/privileged-access-management/service-accounts)).
- **OAuth clients** (Trust credentials page): scoped API credentials
  (client ID + secret), not owned by individual users, non-expiring; minted
  access tokens live 1 hour
  ([OAuth clients](https://tailscale.com/docs/features/oauth-clients)).
- **`svc:` names are Tailscale Services** (virtual services via
  `tailscale serve`), *not* service accounts.

## 4. Groups

Policy-file `groups:` section (`group:admins → [emails]`); the visual editor's
**Groups** tab has **User-defined groups** (full CRUD), **Synced groups**
(read-only, SCIM-populated), and built-in **autogroups**
(`autogroup:admin|member|shared|nonroot`). Synced groups cannot carry user
roles — roles stay console-managed
([visual editor](https://tailscale.com/docs/reference/visual-editor)).

## 5. User & group provisioning (SCIM) and approvals posture

SCIM for **Google Workspace, Microsoft Entra ID, Okta** only (Enterprise for
the latter two); never for custom OIDC. Configured on the **User management**
page (SCIM API key + base URL). Enabling SCIM **disables User approval**.
**Device approval** is a separate posture on the Device management page with
"Needs approval" badges on Machines
([provisioning](https://tailscale.com/docs/features/user-group-provisioning)).

## 6. Terminology and IA

Admin-console pages attested in docs: **Machines**, **Services**, **DNS**,
**Access controls** (tabs incl. `Groups`, `Tags`), **Users**, **User
management** (Identity Provider · User Approval · Join external tailnets ·
SCIM Provisioning), **Device management**, **Trust credentials** (OAuth
clients, auth keys, federated identities), **PAM settings** (Service
accounts), **Configuration logs**.

Canonical terms: *tailnet*, *machine/device/node*, *tag* (`tag:prod`),
*autogroup*, *auth keys*, *OAuth clients*, *Trust credentials*, *User
approval* / *Device approval* ("Needs approval" badges), *User & group
provisioning*, *Identity Provider*, *Switch identity provider*, *Display
name* / *Tailnet ID* / *Legacy ID*.

## OpenSesame mapping (parity grade)

| Tailscale | OpenSesame | Where it lands |
|---|---|---|
| "Sign up with your identity provider" (mandatory at creation) | First-navigation **IdP ceremony** on `/identity`: branded first-class providers + custom OIDC card | Identity screen gate |
| Custom OIDC form (issuer, client id/secret, callback URL) | BYO upstream registration (`POST /v1/federated/byo-upstreams`, ADR 0055) — issuer check, DCR, redirect URI echoed | Ceremony + Providers tab |
| Tailnet bound/locked to IdP; sticky Legacy ID | Local **IdP registry** = the binding this device brokers; org `ssoIssuer` = the server-side binding | Providers tab; Organization tab |
| Users page (roles, states, last seen, filters) | People tab: principal state/assurance, linked identities, org members with roles | People tab (gaps: no fleet-wide user list, no last-seen, no invites API) |
| Switch identity provider | Remove/re-register a brokered IdP (local; server disable is operator-token-only) | Providers tab |
| PAM Service accounts / Trust credentials (OAuth clients) | OAuth clients CRUD (`/v1/oauth/clients`); agents live on the Access screen | Service accounts tab |
| Groups (user-defined / synced / autogroups) | **Gap** — no Group entity; org roles `owner|admin|member` only | Recorded in ADR 0060 |
| User approval ("Needs approval") | Access screen → Requests tab (relay approval inbox, ADR 0046) | Cross-link, not duplicated |
| SCIM provisioning | Org SCIM routes exist (ADR 0056); operator/API surface, not a Pages screen | Recorded in ADR 0060 |
| Device approval | Gateway/control-plane device authorization; approved in Authority screen | Already shipped |
