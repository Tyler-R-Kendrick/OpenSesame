# ADR 0061 — Access becomes the PAM plane; ceremony per action; Authority and Authentication removed

Status: Accepted
Date: 2026-08-29
Supersedes: the tab structure of ADR 0054 (Resources/Policies reshaped) and
the tab structure of ADR 0060 (People reshaped, Devices added)
References: ADR 0005 (ConnectionRef), ADR 0018 (standing grants vs task
authority), ADR 0019 (immutable ceiling), ADR 0044 (claimable connection
delegation), ADR 0046 (relayed execution and the authorization inbox),
ADR 0054, ADR 0055, ADR 0060, competitor references
[`docs/competitors/border0-tailscale-pam.md`](../competitors/border0-tailscale-pam.md),
[`docs/competitors/tailscale-identity.md`](../competitors/tailscale-identity.md)

## Context

ADR 0054/0060 got the screens onto the right routes but missed the point of
the exercise in three ways, called out in review:

1. **The screens describe instead of doing.** Both screens grew explanatory
   prose — taglines, educational captions, connector descriptions — the
   "AI slop" pattern. Border0 and Tailscale admin consoles are terse: table
   headers, actions, one-line empty states. PAM is a set of verbs — grant,
   revoke, approve, terminate — not a set of descriptions.
2. **The Access screen carried non-PAM content.** Connector descriptions and
   vault-secret inventories are catalog material; "Register a service
   account" is provisioning. Neither is privileged access management, and
   both crowded out the PAM verbs.
3. **Everything sat in long continuous forms.** Each fork in the user
   experience (grant vs claim vs approve vs revoke vs add-IdP vs
   approve-device) is a separate ceremony with its own focused form — the
   pattern the IdP ceremony proved — not one long page.

Separately: the **Authority** and **Authentication** screens were never
requested and carry nothing the PAM/identity story needs. Authority's one
PAM-relevant act — device approval — moves to Identity → Devices. The rest
(session introspection, claim-ownership ceremonies, protocol log, the
WebAuthn-service admin console) leaves the Pages UI; the APIs are untouched.

The decisive API fact for "actually doing PAM": the delegation substrate
(ADR 0044) is a complete JIT grant lifecycle — `POST /api/v1/delegations`
mints a **time-boxed, scoped offer** (claim token + user code), the requester
claims it, the grant appears in `GET /api/v1/delegations` with
`claimant/expires_at/revoked_at`, and `DELETE` revokes it. That is Border0's
"no standing privilege; access is a time-boxed grant" model, already shipped
server-side. The relay inbox (ADR 0046) is the approval-gated half. PAM on
this host is real; the screen just had to bind it.

## Decision

**Access (`/access`) is the grantor's PAM plane**, terse and ceremony-driven:

| Tab | PAM verb | Bound to |
|---|---|---|
| **Grants** | grant / revoke / narrow | `GET\|DELETE /api/v1/delegations`, `POST …/{id}/narrow`, mint-offer ceremony (`POST /api/v1/delegations`) |
| **Requests** | approve / deny | relay inbox (ADR 0046) + offers I minted + their status |
| **Sessions** | inspect / terminate | task runs + receipts |
| **Resources** | (what grants point at) | terse connection rows — name, ref, status, [Grant access] [Policy]; no prose, no secret inventory, no registration |
| **Policies** | shape standing rules | per-connection policy + bindings, reached as a drill-in from a resource row |

Every action is its own ceremony, not an embedded form:

- **Grant access** — pick resource → scope (actions, resources, execution
  mode, duration) → mint → a code card (claim token + user code, copy
  affordances) to hand the requester. This *is* JIT access.
- **Approve / deny** — the digest-pinned decision (unchanged mechanics).
- **Revoke / narrow** — confirm sheet per grant.
- **Policy** — drill-in per resource, back-link out.

**Identity (`/identity`) is the person plane**, and absorbs what identity
management actually needs:

- **Providers** — multiple IdP sources, each added through its own ceremony
  (first-class brokered leg, or the custom-OIDC two-step). Already the
  shipped shape; prose stripped.
- **Devices** (new tab) — the device-approval ceremony moved from the deleted
  Authority screen: enter the user code a device/CLI shows, approve, done
  (`POST /v1/device/approve`). Enumeration of devices is operator-only
  server-side; the tab says so in one line instead of faking a list.
- **People → My access** — the requester side of JIT: claim an offered grant
  (claim token + user code ceremony), see grants I hold with their expiry,
  drop one early. Bound to the same delegation routes from the claimant side.
- **People / Service accounts / Organization** — as in ADR 0060, prose
  stripped.

**Authority and Authentication are removed**: nav entries, routes, crumbs,
slots, sections, and their tests. Device approval survives on Identity;
everything else they did is available via API and intentionally has no Pages
UI.

**Secrets unify — there is no "Agent Secrets" capability.** The vault's
`secret` kind was only ever one kind; the "Agent secret(s)" labels and
agent-specific framing leave the UI. A secret is a secret. Its `ceiling` and
`grantees` fields stay, reframed from taxonomy into *optional grant
metadata* — they only matter when the secret is granted to an agent. And
that grant happens through PAM, not through a vault label: the Access
screen's **Grant access** ceremony accepts a secret as its target, resolves
the secret's `connectionRef`, and mints a **time-boxed delegation offer**
over that connection, scoped by the secret's ceiling (ceiling grants → offer
`actions`/`resources`, plus expiry and optional relay-mode approval). This
gives the ceiling its first real enforcement — burn-on-replay, expiry,
digest-pinned approval — where today it is advisory client-side UI that
never leaves the device. No secret bytes move: an agent receives invocation
authority within the ceiling, never the value (ADR 0005, ADR 0048).

**Sites merges into Access.** Site access is access management: an origin
client is a resource that may broker sign-in, its ownership claim is an
approval ceremony, its credential rotation/revocation is grant management,
and its sign-in events are receipts. The separate Sites screen was the same
verbs behind a second door. The consolidation: the Resources tab gains a
**Sites** group (origin-client rows with a **Manage** drill-in and a
**Register a site** ceremony), the drill-in carries rotation/revocation, the
integration snippet, the domain allow/block policy, and the site's sign-in
events; the `/sites` route redirects to `/access` and the nav drops to
Vault · Connections · Access · Identity · Settings.

### Deviations, recorded honestly

- **No user-facing "request access" submission.** The server has no endpoint
  for asking an owner for a grant (relay submission presupposes a delegation;
  org membership has no join-request flow). JIT here is grantor-initiated
  (mint a time-boxed offer, hand over the code) or claimant-initiated (claim
  a code you were handed). A request-submission endpoint is future server
  work; the screen does not fake it.
- **No device/session enumeration.** Pending device sessions and per-session
  token lists have no browser-reachable list route (operator-only). Devices
  is an approval ceremony, not an inventory.
- **No per-connection grant listing.** The grants table is built from
  `GET /api/v1/delegations` (owner- or claimant-scoped), not from a
  connection-centric admin listing that doesn't exist.
- **Resources are connections and secrets.** Connections are the Host's only
  invokable resource type; secrets are grant targets through their
  `connectionRef`. Both render as Border0-style terse rows (name, status,
  actions) — never described, never with prose.
- **Secret grants delegate invocation, never bytes.** No endpoint returns
  vault secret values to anyone, and offer items can't name a vault item or
  secret-config key server-side (`OfferItemSpec` is `connection_id`-only).
  Granting a secret therefore mints a time-boxed delegation over its
  connection, ceiling-compiled to offer scope. A server-side
  secret-addressable grant surface is future work, not faked.

## Consequences

- The Access screen's center of gravity moves from inventory to the grants
  table: standing privilege visible at zero, every grant time-boxed with a
  revoke action — the ZSP posture made operable.
- The mint-offer ceremony gives JIT access a complete UI loop
  (mint → hand over code → claim → time-boxed grant → expire/revoke) for the
  first time.
- Two screens and their prose leave the nav; the IA drops to Vault,
  Connections, Access, Identity, Sites, Settings.
- Test suites are rewritten around the ceremonies and the grants table;
  Authority/Authentication suites are deleted with their screens.
