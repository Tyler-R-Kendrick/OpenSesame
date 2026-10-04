# ADR 0160 — The device identity plane is declared

- Status: Accepted
- Date: 2026-10-04
- Amends: [ADR 0118](0118-device-native-identity-host.md) (§4's "a remote URL
  is set" question is replaced by a per-feature one; §6's `useIdentityPlane()`
  becomes `identityPlane()` and `identityServes(family)`)
- Implements, in part: [ADR 0138](0138-self-issued-identity-one-native-host.md)
  §1 (the principal is the thumbprint of a vault identity key)
- Builds on: [ADR 0090](0090-static-frontend-complete-without-backend.md),
  [ADR 0104](0104-browser-local-identity-sessions.md),
  [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0149](0149-nothing-stored-in-the-clear.md),
  [ADR 0153](0153-minimal-pwa-optional-sections.md),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md)
- Related, not repeated here: [ADR 0116](0116-browser-native-siop-v2.md) §5 and
  [ADR 0117](0117-hosted-siop-oidc-bridge.md) §5 (what Pages is not as an
  OpenID Provider)

## Context

ADR 0118 made Pages answer its own Identity API when Settings names none, so
drops, provisional sessions and the Access probes stopped failing. It never
said what that *is*, and the code kept asking the other question. Nearly every
panel is written `configured && session`, where `configured` means "a remote
URL is set". A device session is therefore invisible to a panel that would
have shown it, and a feature needing a server looks the same as one the device
can answer.

The device session itself was a placeholder. The principal was a random
`prn_…` in a module-level map, per tab, unrelated to anything the person
holds; `/v1/principals/me` said `provisional` with no identities; the
extended routes `identity.local-iam` serves were installed by overwriting one
shared slot, so a second capability could not contribute a family without
displacing the first.

The owner's requirement is that Pages can act as its own identity provider
with no external identity service. This ADR declares that, bounds it, and
states what it will not do.

## Decision

### 1. With no external Identity API, the device is the Identity plane

"The device" is the vault open in this browser. For Pages' own features
(sessions, receipts, requests, notifications, the directory) it is the
authority: nothing outside it is asked and nothing outside it needs to exist.
A configured Identity API remains an override (ADR 0118 §3); it does not merge
with the device plane, and the device host is off while it is set.

### 2. Two functions state it

`packages/app-core/src/lib/identity-plane.ts`:

- `identityPlane(): "device" | "remote"` — `remote` when Settings names an
  Identity API, else `device`.
- `identityServes(family): boolean` — whether the plane that is answering
  serves a route family. It reports what a plane *can* serve, not whether it is
  open: a locked vault still belongs to a plane that serves sessions.

The route families are a closed set: `session`, `audit`, `requests`,
`notifications`, `directory`, `mfa-codes`, `org-signin`, `federation-callback`,
`wallet`. Panels ask `identityServes(family)` (in Pages, `useIdentityServes`)
for the family they need, and keep `isRemoteIdentityConfigured` only for the
features in §3's last row, which need a server and must not pretend otherwise.

### 3. What the device serves, and what it does not

| Family | Device plane | Remote plane |
| --- | --- | --- |
| `session` (principal, bearer, health, claims) | always, from the host core | yes |
| `audit`, `requests`, `directory` | while `identity.local-iam` is on | yes |
| `notifications` | while a capability that delivers them is on (none yet) | yes |
| `mfa-codes` (email and text codes) | never | yes |
| `org-signin` (organization SSO, SAML, LDAP, magic link) | never | yes |
| `federation-callback` (a provider's redirect to a URL of ours) | never | yes |
| `wallet` (pass issuing and provisioning) | never | yes |

A remote plane is asked for every family and refuses over the wire what it
lacks. For the device the last four rows are structural: each needs a server
in the world (a mail relay or SMS gateway, an upstream directory, a publicly
reachable callback, a pass issuer), and a browser tab is none of those. Say so
plainly in the interface; do not draw a row or a panel that implies otherwise.
External notification channels (Slack, Teams, Telegram, SMS, a webhook, Web
Push through a relay) are the same: they need a server, so the device plane
offers the in-app destinations only (ADR 0084).

The registry rejects a contribution that names `session` (the core owns it) or
any of the four server families. The table does not bend to a capability that
would like it to.

### 4. A route registry, not a slot

`device-identity-routes.ts` holds *contributions*. A capability registers one
from `activate` and the returned function removes it on dispose; nothing runs
at import. A contribution has an `id` (its capability), the families it
`serves`, a `dispatch(request)` that answers a path or returns `null`, and an
optional `assurance(tomb)` (§6). The first contribution that recognises a path
answers it; two capabilities coexist; registering the same `id` again replaces
the earlier one, and the earlier one's late unregister cannot remove its
successor. A contribution may answer a refusal for a family it does not serve
(`identity.local-iam` still answers the code routes with 503). `identity.local-iam`
contributes `directory`, `audit` and `requests`, with the routes it served
before, unchanged. The request a contribution receives carries the resolved
caller (`principalId`, `tomb`, `guest`) and never the bearer.

### 5. The principal is a key

For an open vault the principal is `prn_` plus the RFC 7638 thumbprint of a
P-256 key sealed in that vault's VFS (`config/device-identity-key`, under the
vault key, ADR 0149). The key is created the first time the host needs a
principal for the tomb, under a Web Lock so exactly one is minted, and read
back thereafter. A record whose key id is not its public key's thumbprint is
refused and nothing is minted over it. The private half is never returned by
any route, and the host never prompts a passkey to make or read it: it runs in
a vault the person has already opened.

Bearers stay memory-only and per tab (24 hours). A session is *bound* to the
tomb and key it was minted in: it answers only while that vault is open, and
another vault opening ends it, so a bearer never follows a person from one vault
to another. With no vault on the device yet there is nothing durable to derive
from, so the host mints a random provisional principal, unbound, as ADR 0118
did.

How this relates to the other keys:

- **Local IAM** (ADRs 0102–0112) owns people, passkeys, applications and
  grants, and its principals are `local_…` directory ids. The device principal
  is not a person in that directory and is not derived from one. They meet only
  at assurance (§6).
- **SIOP keys** (`siop-keys.ts`, ADR 0116) are pairwise: one per (person,
  application), minted for a relying party. The device key is the root a
  relying-party subject would be derived beside (ADR 0138 §1), not one of
  those, so it is its own record. It has the same JWK shape, so signing with it
  later is not a migration. `device-identity-key.ts` cannot import
  `@opensesame/siop-v2` (owned by `identity.siop`), so it computes the
  thumbprint itself and a test pins it to siop-v2's.
- **Not yet built from ADR 0138 §1:** the key is not carried by vault sync or an
  offline backup, so a second device derives a different principal, and nothing
  signs with it. The ADR does not claim either.

### 6. Assurance is read, never granted

`/v1/principals/me` reports `assurance: "provisional"` unless a contribution
vouches for the open vault *and* names when it was proved. `identity.local-iam`
vouches `phishing_resistant`, with `verifiedAt`, only while a local identity
session from a real passkey authentication (ADR 0104: the verifier ran, the
evidence was spent once, bound to this origin and vault) is live in this tab.
How the vault was opened is not evidence: a password unlock proves a password.
A claim above `provisional` with no time of proof is ignored. The state is
`active` for a member vault with a key and `provisional` otherwise.

### 7. A locked vault answers `locked`, and never falls back

When a vault is on this device and none is open, the device routes answer
`423 {"error":"locked"}`. Nothing is issued: no session, no principal, no claim.
A session bound to a vault answers `locked` until that same vault opens. There
is no plaintext fallback and no cached principal: a locked device does not
speak for the vault. "A vault is on this device" is read from the tombs
registry and the last-vault pointer, both already plaintext by design (ADR 0063);
the host does not import the vault store, which sits on its import cycle.

### 8. A guest keeps a provisional principal

A guest runs in the isolated guest tomb (ADR 0135 and the AGENTS.md guest
rule). Its key is sealed in that tomb, so it is stable for that guest session
and discarded with it; its state and assurance are `provisional`, and no proof
from a member's vault can raise it. The member's tomb is never read or written.
The guest road is untouched: no guest entry is gated on identity availability
or on this plane, and a guest with no Identity API is complete, not pending.

### 9. What the device plane must not do

- No wildcard CORS, and no endpoint readable from another origin. The host is
  an in-tab function; it is not an HTTP listener and registers no service
  worker route. A service worker answers only controlled same-origin GETs and
  cannot be a token endpoint for other origins, so none is built.
- No widening of model authority. A model, WebMCP or an agent cannot mint a
  session, grant consent or raise an assurance through these routes; human-only
  consent and exact-origin and source binding (ADRs 0104, 0106, 0112) are
  untouched.
- No credential or secret in a response, a log or an event; bearers and keys
  go through the scrubber (ADR 0157).
- No row, glyph or caption for what the plane does not serve (ADR 0158); no
  copy that names a service that is not there.
- The service row stays "This device" as the unchanged default; the existing
  sheet's change action overrides it. It is not drawn as a static status.

### 10. The limit: Pages is not a conventional OpenID Provider

The device plane is an identity plane for Pages' own features and for
browser-local applications admitted by ADR 0106 and its siblings. It does not
publish a discovery document, JWKS or token endpoint that a third-party
relying party on another origin could call, and it cannot: a browser tab is not
reachable by other origins at a stable address. ADR 0116 §5 and ADR 0117 §5
keep the browser-signed conventional OIDC facade unimplemented. The honest
statement of what a relying party can and cannot rely on belongs to the
companion ADR on Pages as an OpenID Provider (numbered 0161 when it lands), and
this ADR does not repeat it.

## Consequences

- A panel asks for what it needs. A device session is visible to a panel that
  wants a session; a panel that needs an inbox, a mail relay or an upstream
  directory is not fooled by one.
- Adding a family to the device is one contribution from the owning capability,
  with its own tests; later receipts, local notifications and the push panel
  register `audit` and `notifications` the same way.
- Access › Receipts is drawn only where the answering plane serves `audit` and a
  session is held: a device with Access on and local IAM off no longer draws a
  receipts panel that could only fail.
- A device has a stable principal per vault, and a locked one has none to give.
  A guest's is as short-lived as the guest.
- The principal is not portable yet (§5, last bullet). That is the next
  increment of ADR 0138 §1, not a property to assume.

## Verification

- `identity-plane.test.ts`, `device-identity-routes.test.ts`,
  `device-identity-key.test.ts`, `device-identity-principal.test.ts`,
  `device-identity-vault.test.ts` and `local-iam-assurance.test.ts` pin the
  truth table, the registry, the key, the principal, the locked, guest and
  assurance behaviour above.
- `verify:device-identity` drives a guest on a static build with no Identity API
  at desktop and mobile widths: the sign-out row appears only after the device
  session exists, the connectivity status reads "This device", and none of the
  forbidden copy appears across Settings and Access.
- `verify:static`, `verify:local-iam`, `verify:siop`, `verify:keyboard`,
  `verify:mobile` and `verify:auth` stay green.
