# ADR 0060 — An Identity screen with a mandatory-once IdP ceremony

Status: Accepted
Date: 2026-08-29
References: ADR 0007 (dual-plane identity/authority), ADR 0033 (federated
identity admission), ADR 0054 (Access screen), ADR 0055 (provider registry,
BYO and org sign-in), ADR 0056 (SAML/SCIM/directory federation), ADR 0057
(email linking), ADR 0059 (passwordless authentication service), competitor
reference
[`docs/competitors/tailscale-identity.md`](../competitors/tailscale-identity.md),
design spec
[`docs/design/identity-screen.md`](../design/identity-screen.md)

## Context

OpenSesame brokers sign-in to upstream IdPs the way Tailscale does: the
Identity API is an OIDC issuer that federates out to a provider registry
(ADR 0055). The brokering machinery is real and shipped — a fetched provider
catalog, brokered PKCE legs, BYO OIDC upstream registration with SSRF-fenced
discovery and RFC 7591 DCR, linked external identities per principal, org
SSO/SAML/LDAP/SCIM bindings (ADR 0056), OAuth client CRUD, and agents. What
does not exist is the **management surface** for any of it. A BYO upstream
registered during sign-in can never be seen again; the provider registry has
no UI; the people an IdP vouches for have no UI; OAuth clients are API-only.

Tailscale's identity model is the craft bar ([competitor
reference](../competitors/tailscale-identity.md)): a tailnet **cannot exist
without an IdP** — the "Sign up with your identity provider" ceremony is
front-loaded and mandatory, the binding is sticky, and the admin console then
manages users, roles, service identities, and groups under that binding.

## Decision

Pages gains an **Identity** section (`/identity`), the identity-plane
companion to the Access screen, with Tailscale's identity IA as the parity
target. Because brokering requires a registered IdP, the section is gated by
a **first-navigation ceremony**: until at least one IdP is registered (or the
operator explicitly defers), `/identity` renders "Connect your identity
provider" — branded first-class provider buttons plus a custom-OIDC card
(issuer → discovery → optional client credentials → register) — mirroring
Tailscale's mandatory signup ceremony. A "Set up later" link keeps guest
primacy (guests remain a first-class posture everywhere else in the app).

| Tab | Tailscale counterpart | Bound to |
|---|---|---|
| **People** | Users page (roles, states) | `GET /v1/principals/me`, `GET|DELETE /v1/principals/identities`, org members + roles |
| **Providers** | User management → Identity Provider | Fetched catalog (`/v1/federated/providers`) + local BYO registry mirror (`POST /v1/federated/byo-upstreams`) |
| **Service accounts** | PAM Service accounts / Trust credentials | OAuth clients CRUD (`/v1/oauth/clients`); agents cross-linked to Access |
| **Organization** | tailnet settings / domain binding | `/v1/organizations` (create with `ssoIssuer`, membership, roles) |

### The local IdP registry is the binding

Tailscale's tailnet↔IdP lock maps to a **local registry**
(`lib/idp-registry.ts`, localStorage) recording every IdP this device brokers:
BYO registrations as returned by the server, plus first-class providers chosen
through the ceremony. This is a deliberate consequence of the server
contract: the admin BYO list endpoint is operator-token-only (ADR 0055), so a
browser client cannot enumerate server-side registrations — it can only
mirror what it registered itself. The registry records the binding, drives
the ceremony gate, and feeds the Providers tab. Registrations made before
this feature (or from other devices) don't appear; the doc and the UI both
say so.

### Terminology

The UI speaks Tailscale's language where it maps — *people*, *providers*,
*service accounts*, *organization* — and keeps OpenSesame terms where the
concepts differ: *linked identities* (not "logins"), *assurance* (not
"last seen"), *principal* in technical captions. The nav label is
**Identity**; the route is `/identity`.

### Deviations, recorded honestly

- **No fleet-wide user list.** There is no cross-deployment principal-list
  endpoint; the People tab shows *me* (state, assurance, linked identities)
  plus members of orgs I belong to. A Tailscale-style Users table needs a
  server admin endpoint that doesn't exist yet.
- **No invitations.** Membership is add-by-principal-id or JIT via SSO/SCIM;
  there is no invite-by-email or invite-link API.
- **No groups.** No Group entity exists (org roles only; the `teams` table
  has no routes). Groups are recorded as future server work, not faked.
- **No last-seen / idle detection.** Assurance and state are shown instead.
- **Registration removal is local.** The server offers disable-only, gated by
  an operator token; the Providers tab removes the local mirror and says
  exactly that.
- **User approval queues live in Access.** The relay approval inbox
  (ADR 0046) is our "Needs approval" surface; the Identity screen cross-links
  rather than duplicating it.

### What this does not change

No server routes, no trust boundaries, no new secrets surface. The ceremony
reuses the shipped BYO registration path (ADR 0055) and brokered sign-in
legs; every tab binds existing endpoints through `identityFetch` with the
same caller identity as the rest of Pages. The sign-in hub's social bar and
BYO sheet are untouched — they *consume* the registry; this screen *manages*
it.

## Consequences

- The BYO upstream registry, linked identities, and OAuth clients get their
  first UI; ADR 0055's brokering becomes operable from a browser.
- The ceremony makes the IdP binding an explicit, inspectable act instead of
  a side effect of the first sign-in — and gives "registered IdPs" a home.
- New client code is confined to two seamed libs
  (`apps/pages/src/lib/directory.ts` for the identity-plane reads/writes,
  `apps/pages/src/lib/idp-registry.ts` for the local binding store) — the
  same seam pattern as `lib/access.ts`, tested the same way.
- Parity is graded against the competitor reference: the ceremony, the tab
  set, and the entities per tab must each be traceable to a row in the
  mapping table. Future identity work (fleet user lists, invites, groups,
  SCIM UI) extends this screen rather than inventing a new one.
