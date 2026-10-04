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
any of the four server families, and the host answers the paths of the server
families itself (the code routes with 503 `not_configured`, the rest 501),
whoever is registered. The table does not bend to a capability that would like
it to (§4).

### 4. A route registry, not a slot

`device-identity-routes.ts` holds *contributions*. A capability registers one
from `activate` and the returned function removes it on dispose; nothing runs
at import. The table it enforces is real:

- **A path has one family.** `familyOfPath` maps path prefixes to the closed set
  (longest prefix wins, so `/v1/organizations/tenants` is `org-signin` and
  `/v1/organizations` is `directory`). A path in no family is served by nobody.
- **A family has at most one owner.** A contribution is `{ id, routes }`, where
  `routes` maps a family to its handler. Registering a family another
  contribution already serves is refused, so a later registrant cannot shadow
  `identity.local-iam`. Registering the same `id` again replaces it, and the
  earlier registration's late unregister cannot remove its successor.
- **A handler answers only its family.** The registry routes a request to the
  owner of the path's family and no other; a handler is never asked about a
  path outside it, and `null` leaves the path unserved (501).
- **A family is served only while a handler is registered.** `identityServes`
  reads the handlers, not a declaration, so a family cannot be reported served
  with nothing behind it.
- **One handler's failure is its own.** A handler that throws answers 500, is
  recorded by contribution id and family only (no message, nothing it saw), and
  does not touch another contribution.
- **A handler is not handed a bearer.** Its request is `{ path, bare, method,
  family, body, caller }`: the resolved caller (`principalId`, `tomb`, `guest`)
  and a string body, never `RequestInit` or any header.
- **Changes are announced.** `subscribeDeviceRoutes` tells a panel when a
  family appears or goes (`useIdentityServes` subscribes), because a capability
  activates asynchronously and a panel that drew first must not stay without
  what arrived a moment later.

`identity.local-iam` contributes `directory`, `audit` and `requests`, with the
routes it served before, unchanged.

### 5. The principal is a key

For an open vault the principal is `prn_` plus the RFC 7638 thumbprint of a
P-256 key sealed in that vault's VFS (`config/device-identity-key`, under the
vault key, ADR 0149). The private half is never returned by any route, and the
host never prompts a passkey to make or read it: it runs in a vault the person
has already opened.

**Minting is fenced.** The key is created the first time the host needs a
principal for the tomb, inside a Web Lock named for the tomb that re-reads
before it writes, so exactly one key exists across tabs. Reading a key that
exists needs no lock. With no cross-tab lock (no `navigator.locks`) nothing is
minted: two tabs that both missed would both mint, one write would win and the
other tab would hold a principal that is not the vault's. This is the refusal
every comparable fence in the client makes.

**A record that cannot be trusted is never replaced.** An unknown version, a
shape this build does not know, or a key id that is not its public key's
thumbprint is `unreadable`: it is left exactly as it is (a newer build may own
it) and nothing is minted over it.

**A provisional session still opens when no key can be had.** Before there was
a key, Connect always succeeded, and it must not become unavailable for a vault
because of a record or a browser. When the key is `unreadable` or there is
`no-fence`, the host mints a random, unbound, `provisional` principal, as it
does with no vault, and the mint answer carries `identityKey: "unreadable"` or
`"no-fence"` so the cause is visible rather than silent. Such a session is
handed to capability handlers with no tomb, claims no assurance, and is not the
vault's principal.

Bearers stay memory-only and per tab (24 hours). A session is *bound* to the
tomb **and the key** it was minted with, and the binding is checked on every
use against what the open vault holds now: a tomb has a fixed name (the guest
tomb above all), so the name proves nothing, and a tomb recreated or restored
with another key is another principal. The old bearer is ended, and anything
unreadable fails closed. A bound session answers only while that vault is open;
another vault opening ends it, so a bearer never follows a person from one vault
to another. With no vault on the device yet there is nothing durable to derive
from, so the host mints a random provisional principal, unbound, as ADR 0118
did.

How this relates to the other keys:

- **Local IAM** (ADRs 0102–0112) owns people, passkeys, applications and
  grants, and its principals are `local_…` directory ids. The device principal
  is not a person in that directory and is not derived from one, and nothing
  binds one to the other yet (§6).
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

### 6. Assurance is provisional, and says so

`/v1/principals/me` reports `assurance: "provisional"` for every session, and
no `verifiedAt`. A live local identity session from a real passkey
authentication (ADR 0104) proves that a local *person* in this vault's
directory signed in; the vault holds several such people (an invited member's
sign-in to an application is one), and nothing binds a person to this device
principal. Raising the principal on it would claim a proof that was never
about it, so the device does not. How the vault was opened is not evidence
either: a password unlock proves a password. The state is `active` for a member
vault with a key and `provisional` otherwise. A higher assurance returns only
with a binding the ADR can name: a signature by the device key, or an explicit
owner link in the directory, each its own decision.

### 7. A locked vault answers `locked`, and never falls back

When a vault is on this device and none is open, the device routes answer
`423 {"error":"locked"}`. Nothing is issued: no session, no principal. That
includes **every claim route** (create, poll, present), whatever the session:
one minted before any vault existed, then a vault created and locked, is
refused like any other, because a claim holds what a vault sealed. Health and
revoke keep working. A session bound to a vault answers `locked` until that same
vault opens. There is no plaintext fallback and no cached principal: a locked
device does not speak for the vault. "A vault is on this device" is read from
the tombs registry and the last-vault pointer, both already plaintext by design
(ADR 0063); the host does not import the vault store, which sits on its import
cycle.

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
  `device-identity-key.test.ts`, `device-identity-principal.test.ts` and
  `device-identity-vault.test.ts` pin the
  truth table, the registry, the key, the principal, the locked, guest and
  assurance behaviour above.
- `verify:device-identity` drives a guest on a static build with no Identity API
  at desktop and mobile widths: the sign-out row appears only after the device
  session exists, the connectivity status reads "This device", and none of the
  forbidden copy appears across Settings and Access. A second scenario seals a
  password vault: its bound principal is the key's thumbprint, locked it
  answers 423 and issues nothing, unlocked it is the same principal, and a
  guest beside it is another principal that the member's bearer does not speak
  for. A third holds the local IAM chunk back and shows Receipts arrive without
  a navigation.
- `verify:static`, `verify:local-iam`, `verify:siop`, `verify:keyboard`,
  `verify:mobile` and `verify:auth` stay green.
