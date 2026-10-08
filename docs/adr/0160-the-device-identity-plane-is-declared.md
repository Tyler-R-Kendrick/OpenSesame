# ADR 0160 — The device identity plane is declared

- Status: Accepted
- Date: 2026-10-04
- Updated by: [ADR 0162](0162-device-receipts-inbox-and-local-notifications.md)
  (§1 and §3, the `notifications` row; and the Receipts consequence)
- Amended: 2026-10-07, §7 (sealing a claim stays gated on the open vault;
  poll and present of one already sealed run while the vault is locked)
- Amended: 2026-10-04, §5 (the key travels with the vault; the earlier limit is
  closed)
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
(sessions, receipts, requests, the directory) it is the authority: nothing
outside it is asked and nothing outside it needs to exist. It also tells its
person about what waits, itself, with no plane route in between
([ADR 0162](0162-device-receipts-inbox-and-local-notifications.md)).
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
| `notifications` | never: the device's own channels belong to `notifications.local` and no panel asks the plane for them ([ADR 0162](0162-device-receipts-inbox-and-local-notifications.md)); the registry still lets a capability register it the day one does | yes |
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
- **Not built from ADR 0138 §1:** nothing signs with the key yet. That is a
  later increment, and the ADR does not claim it. The key's travelling is
  §5a.

### 5a. The key travels with the vault

The key is a tomb file, and the portable forms of a vault carry the header and
the sealed body, not the tomb's other files. So the key was lost whenever a
vault moved: a backup restored on another device, or a vault first synced
there, derived a different principal. It now rides in the body.

**Where.** `VaultBody.deviceIdentityKey` is an optional member of the sealed
body (`packages/vault-core/src/device-key.ts`): the same record the tomb file
holds, `{ version, keyId, publicJwk, privateJwkJson, createdAt }`. The body
version stays 1 and a build that has never heard of the member opens the vault
and ignores it. What an older build does *not* do is carry it on: it rebuilds
the body from the members it knows (as it already does for `itemTypesAt`), so
its first re-save of the body drops the member. Nothing is lost for good: the
tomb file on each device is untouched, and the next unlock, merge or restore on
a build that knows the member puts it back (from the tomb, or from another
device's body). Between those two moments a backup or snapshot made by the older
build carries no key. The format document says the same (§6), and the vector
`backup-device-identity` pins the member. The body is sealed under the vault key,
so only someone who can open the vault gets the key, as with every secret in it.
The tomb file stays the host's working copy; the body is the carrier.

**A record is trusted or it is not a key.** Everything that ranks, adopts,
restores or publishes a key first passes one door
(`device-identity-trust.ts`). The record has the shape this build reads, and
that shape is bounded before anything is hashed, parsed or imported: the key id
and each public coordinate are exactly the 43 base64url characters an encoder
writes for 32 bytes, with the padding bits of the last character zero (a
respelling of the same bytes names the same key under another id, and so
another principal, and WebCrypto in a browser reads it), and the private half is
at most 4096 characters. Its `createdAt` is a whole time inside the window of
the vault it is read for: no more than a day past this device's clock and no
more than a day before the vault's header says the vault was made (the clock
margin; a record dated outside it is not one an honest device wrote, and a
forged date must not decide a ranking). Its key id is the RFC 7638 thumbprint of
its public key, and its private half is that public key's, proven by signing
with one and verifying with the other. Anything else (a forged id, a
respelled coordinate, a private half that belongs to another key, a `null`, a
string, a number, an impossible time) is *poison*: it is treated as absent,
never ranks, never wins, never replaces a genuine key on either side, and is
dropped from a body that would carry it on. One kind of record is not poison and
is not trusted: a version this build does not know, which is left exactly as it
is on both sides with nothing minted beside it. It has to look like a key
record to be honoured as one: a whole version above 1, a text key id of at most
128 characters, a public key object, and at most 8192 characters of JSON. A
high version number on anything else is poison, or anyone who can write a body
could stop a vault from ever making its principal.

**What carries it, and how that is shown.**

| Carrier | How it carries the key |
| --- | --- |
| Offline backup, sealed export | The sealed body, as stored. |
| Tailnet drive (ADR 0144) | The body in each snapshot, ranked by `mergeVaultBodies` after each side's key is vetted; a different key is different content, so a drive holding another key is replaced. |
| Restore of a backup (`importSealed`) | Only when the person takes it; see below. |
| Travel (ADR 0143) | Every tomb file by its storage name, the key file included, byte for byte. |
| `opensesame vault verify\|ls`, `opensesame-id vault ls` | List `config/device-identity-key` as `concealed`, by path alone, and count it as no item. A `null` member is absent in both readers; any other value is listed by name and read as no key. |
| `client-core` sync and the envelope's `syncBlobs` | Not carriers of a Pages vault. `client-core` syncs opaque Host records and has never held a tomb or a vault body, and nothing fills `syncBlobs`, so there is no key for them to carry. |

**Keeping the two copies one.** At unlock and after a merge the store levels
the tomb's key with the body's (`device-identity-carry.ts`), under the same Web
Lock that fences minting:

| Tomb | Body | Does |
| --- | --- | --- |
| none | none | Nothing; the first use mints. |
| none | trusted key | The tomb takes the body's. A second device is the same principal. |
| key | none, or poison | The body takes the tomb's. A vault from before keys travelled starts carrying it, and a forgery in the body is replaced. |
| key | same key | Nothing. |
| key A | trusted key B | The older `createdAt` wins; on a tie the smaller key id. |

Minting is unchanged: only under the lock, and never over a record it cannot
read. A key the host mints is published to the body at once. Taking a carried
key and ranking two keys are deterministic and idempotent, so a browser with no
cross-tab lock still does them; it still mints nothing.

**What is published is dated inside the window.** The tomb's file is this
device's own and is read as it was written, with no upper bound on its date, so
a clock that ran ahead and was put back cannot lock a vault out of its own
principal. What goes into the body is that key with its `createdAt` brought
inside the vault's window (never later than now, never a day before the vault
existed), and that clamped date is what it is ranked by, so a date beyond the
margin cannot make a key outrank an honest one nor leave a body the readers
call poison. The publish seam itself vets what it is offered (a record that is
not a genuine key is never carried) and writes nothing when the body already
carries that key, so an unlock that finds the two copies level, which is every
unlock after the first, seals no new revision; the vault's revision is the same
after three unlocks as after the first.

**Writes to the body are not made from a stale tab.** The vault body is written
by whichever tab holds it, and a tab may hold a body another tab has since
changed. So a plain read of the principal writes nothing (a vault from before
keys travelled gets its key into the body at its next unlock, not at a read),
and *every* write the store makes, an ordinary edit as much as the key's, goes
through one step (`#exclusive` in `store.ts`): queued on the store's write chain,
then under the cross-tab body lock, starting from the header read again and,
when the body on disk is not the one this tab last wrote or read (the seal's IV
says so without opening it), from the disk's copy. Another tab's edit is kept,
the identity key another tab published is kept (an ordinary edit from a tab that
is behind cannot drop it from the sealed body), and the sealed revision is never
one the header has already moved past. The guarantee is as good as Web Locks: a
browser that has stored files and no Web Locks writes bare, as it always did,
and a stale tab there can still seal a body without the member; the tomb file is
untouched and the next unlock, merge or restore puts the member back, and that
browser mints and adopts nothing. A guest or scratch session has no header of its
own beside the vault and starts from its own body. The order is always the
identity lock, then the write chain, then the body lock, never another: a
publish that held the body lock and then queued on the chain used to wait for a
`destroy()` that had queued on the chain and was waiting for the body lock, so
deleting a vault while a key was being published never finished. Now `destroy`
and every write take the chain and then the lock, and the key's publish and a
restore write through the step they were handed, not a second queue. A merge
writes the merged body and levels the tomb's key in one step under the identity
lock; a restore that takes the key writes the tomb's file and then the body, and
puts the tomb's file back (or removes it, if there was none) when the body
cannot be written or when another tab gave the vault something in between (the
body is checked again under the locks), so a failed restore fails loudly and
leaves the vault as it was.

**The seam is not a public surface.** The store hands its body to
`store-device-key.ts` once (`registerBodyPort`) and installs the carrier the
device host reads and writes through (`installDeviceKeyCarrier`); `bodyPortOf`
is how a test reaches it. They hand out the whole sealed body, so
`pnpm quality:app-core` fails on any importer that is not `store.ts`, that module,
the golden-vector generator or a test, in any package or app
(`scripts/lib/app-core-seams.mjs`).

**Ranking happens only where the author is a device of this vault.** A tailnet
snapshot opens only under this vault's own key and its `createdAt` must equal the
header's (`openSnapshotBody`), so it is a device's own: there, and in the
reconcile above, two keys are ranked. A backup is another matter. Its header
(plaintext) and body are whatever its author wrote, and the author needs only the
victim's header time, which is plaintext, to claim it. So **nothing in a backup
ranks against a key the vault holds**, and a restore never decides by comparing
header times.

**Restoring.** A restore is a fresh vault plus `importSealed`. The items always
merge. The backup's key is considered only when both hold:
- the vault has done nothing yet (no item, live or trashed, and no folder), and
- the person chose "Also take its device identity" on the restore card.

The choice is offered only to such a vault and is off until chosen; it is the
confirmation, drawn as the same labelled check the sealing screen uses, not a
verb on a button. It is drawn only where a vault can take an identity: not for a
guest or scratch session (which carries no key), not where the browser has no Web
Locks to fence the tomb's key against another tab, and not for a vault with an
item or a folder. Where any of that is not so the control is absent, not drawn
and dead (ADR 0158), the restore sends no choice, and the store refuses on the
same terms if asked anyway. With the choice made:
- A trusted key becomes this vault's, even if this vault already minted one and
  whichever is older. If the vault had a different key, its sessions end (the key
  id binding) and the bell says "Device identity changed", that the person took
  the backup's key. If it had none, nothing is lost and nothing is announced.
  The key is taken *dated just before the one it replaced* (never after its own
  date, always inside the vault's window), because another device of this vault
  still holds the replaced key and a merge keeps the older of two: without that,
  the next sync put the old key back on the device that had just taken the new
  one and the person's choice lasted until the first merge. A key some third
  device minted earlier and has not yet synced still ranks first, which is the
  rule every two keys meet under, and that device's person is told when it
  happens. If the vault's own record cannot be read it is never replaced: the
  items merge, nothing else changes, and the bell says "Identity key not taken",
  that this device's own record could not be read.
- A backup with no key (made before keys travelled): the vault keeps its own, one
  key is minted exactly once under the lock if it had none, and the bell says
  "Restored without an identity key".
- A backup whose key is poison or of a version this build cannot use: the vault
  keeps its own and the bell says "Identity key not taken", that the key is one
  this device cannot use.

Without the choice, or for a vault with content, the backup's key is ignored and
nothing is said. A hostile backup that copies the victim's header time and dates
its key as early as it can therefore changes nothing in a vault with content, and
changes a fresh vault only when its person chose to take it.

**Two devices, one vault, one principal.** Devices that sync a vault are the same
principal by design. Session bearers stay per device, per tab, in memory (24
hours), and a bearer minted on one device is not honoured on another. The
consequence is the vault's own: whoever can open the vault holds the key, and
there is no rotation. A person who wants another principal makes another vault.

**Two devices that each minted a key before they first met.** Their keys differ.
When their bodies meet on a merge, both devices reach the same answer by the
ranking above, whichever syncs first. The device holding the other key replaces
its tomb file; the session binding (the key id, above) ends every bearer minted
under the loser on its next use, and the bell says "Device identity changed", that
this vault already carried an older key. The winner changes and announces
nothing.

**Concealed, everywhere.** The key is a secret and is listed by name only. No
Settings file provider offers it, and the viewer drops it from any listing and
refuses to read, check, write over or remove any path that names it
(`withoutConcealedFiles`), so a person cannot paste over it. The configuration
registry treats its path as forbidden. A backup's coverage record counts it as
carried. The native reader skips the member as it parses (it never builds the
private half into a string) and reports only that it is present. A guest carries
none: a guest's key lives in the guest tomb, which is never exported or synced.
The guest tomb's wipe removes the key file with the rest of the tomb's config, so
a new guest does not meet the last one's ciphertext.

The notices are bell notices, not captions on a screen (ADR 0158); each says what
happened in that case and no other.

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
`423 {"error":"locked"}`. Nothing is issued: no session, no principal.
Sealing a claim (`POST /v1/claims`) is included, whatever the session: one
minted before any vault existed, then a vault created and locked, is refused
like any other, because a claim is sealed from the open vault. Polling
(`GET /v1/claims/:id/poll`) and presenting (`POST /v1/claims/present`) are
not. They touch the origin's claim store, not the vault body, so a recipient
opens a drop while their own vault is locked. Health and revoke keep working.
A session bound to a vault answers `locked` until that same vault opens.
There is no plaintext fallback and no cached principal: a locked device does
not speak for the vault. "A vault is on this device" is read from the tombs
registry and the last-vault pointer, both already plaintext by design
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
  with its own tests; later receipts register `audit` the same way, and a
  family nobody reads through the plane (`notifications`) is not served for the
  sake of having a row.
- Access › Receipts is drawn only where the answering plane serves `audit`: a
  device with Access on and local IAM off no longer draws a receipts panel that
  could only fail. Against a remote plane it also needs a held session; on the
  device it reads the vault's own sealed trail and needs none, because the
  unlocked vault is the authority ([ADR 0162](0162-device-receipts-inbox-and-local-notifications.md)).
- A device has a stable principal per vault, and a locked one has none to give.
  A guest's is as short-lived as the guest.
- The principal is the vault's, so it is portable: a backup restored on
  another device, or a vault synced to one, keeps it (§5a). It is the same
  principal on every device that holds the vault, and whoever can open the
  vault holds its key.

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
- The key's travelling is pinned in four planes. `vault-core`:
  `device-key.test.ts` (reading, ranking, commuting and converging merges) and
  `vault-file.concealed.test.ts`. `app-core`: `device-identity-carry.test.ts`
  (every row of the table, the tie, the untrusted record, the restore plan),
  `device-identity-key.carried.test.ts`, `vault/device-key-restore.test.ts`
  (a real store: backup, wipe, restore with and without the choice, the
  keyless and unusable backups, a restore that cannot finish, a guest),
  `vault/device-key-hostile.test.ts` (a backup that copies the victim's header
  time), `vault/device-key-stale-tab.test.ts` (two tabs),
  `vault/device-key-concurrency.test.ts` (an ordinary edit from a tab that is
  behind keeps the other tab's key and edit; a delete and a publish settle in
  either order), `vault/device-key-clock.test.ts` (a key dated outside the
  window, three unlocks, one revision), `vault/device-key-restore-guards.test.ts`
  (the second freshness check and its rollback, a browser with no Web Locks, an
  unreadable own record), `device-identity-trust.test.ts` (the door, with a
  respelled coordinate, oversize fields and a bare high version number),
  `tailnet-sync/device-identity-sync.test.ts` (two devices, in either order of
  sync, the loser's bearer ended, a forged or null record never winning),
  `tailnet-sync/device-identity-restore-sync.test.ts` (a key taken from a backup
  survives the next sync on the other device), `sections/vault/import/model.test.ts`
  and the Pages `ImportSheet.identity.test.tsx` (the card's choice is absent for a
  guest, the guest tomb, no Web Locks and a vault with content),
  `scripts/lib/app-core-seams.test.mjs` (the seam gate), `travel/travel-identity-key.test.ts`,
  `sections/settings/virtual-files.test.ts` and the Pages
  `providers.concealed.test.tsx`. Across planes, the vector
  `backup-device-identity` is written by the TypeScript store and read by the
  TypeScript reader, the Rust reader (`pages_vault_vectors.rs`), `opensesame
  vault ls` and `opensesame-id vault ls`, each of which lists the path and none
  of the key.
- `verify:device-identity` also walks backup and restore in real browser
  contexts, one per device: export an offline backup, restore it on a fresh
  device taking its identity on the card and the principal is the same; restore
  over a vault that had minted its own and its bearer ends and the bell says so;
  a keyless backup mints one key and says so, and that key travels with the next
  backup; a restore that declines the identity keeps the vault's principal and
  says nothing; and a guest session's restore card draws no choice at all.
- `verify:static`, `verify:local-iam`, `verify:siop`, `verify:keyboard`,
  `verify:mobile` and `verify:auth` stay green.
