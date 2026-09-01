# ADR 0086 — One interaction primitive: wallets, QR codes and passes are adapters over it

Status: Proposed
Date: 2026-08-31
References: ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0009 ([claims vs device auth](0009-claims-vs-device-auth.md)),
ADR 0045 ([hosted ceremony pages](0045-hosted-ceremony-pages.md)),
ADR 0046 ([relayed execution and the authorization inbox](0046-relayed-execution-and-authorization-inbox.md)),
ADR 0058 ([native authenticator and OpenID4VC wallet](0058-native-authenticator-and-openid4vc-wallet.md)),
ADR 0061 ([Access/PAM plane ceremonies](0061-access-pam-plane-ceremonies.md)),
ADR 0065 ([agent surface parity](0065-agent-surface-parity.md)),
[protocol conformance](../protocol-conformance.md),
[threat model](../security/threat-model.md)

## Context

OpenSesame runs the same human moment over and over. Approve this device.
Claim this resource. Allow this call. Authorize this payment. Each time,
something has to reach a second screen, be understood by a person, and come
back as a yes or a no.

Every surface that needed this built its own. The count, at HEAD:

| Surface | What it built | Where |
|---------|---------------|-------|
| Ceremonies app | `?user_code=` links, `#token=` fragments | `apps/ceremonies/src/lib/deep-link.ts` (via ceremony-kit) |
| Mobile MFA | its own parser, accepting `?code=` as an alias, no fragment scrub, `opensesame-mfa://` scheme | `apps/mobile-mfa/src/App.tsx:33-48` |
| Console | its own `POST /v1/device/approve` and status copy | `apps/console/src/pages/DevicePage.tsx:28-46` |
| Pages | two more of the same call | `apps/pages/src/lib/directory.ts:404`, `identity.ts:384` |
| Authenticator link | a third scheme, `opensesame://invoke/mfa` | `apps/ceremonies/src/lib/authenticator-link.ts:141` |

`@opensesame/ceremony-kit` exists precisely to stop this — its own header says
the device-approval flow "was written four times" — and it is a dependency of
exactly one app. Three link formats and five call sites is not a styling
problem. It is five places to get expiry, replay, fragment hygiene and
enumeration wrong, and four of them already differ from each other in ways
nobody chose.

Adding a Google Wallet pass to that would make six. So the pass is not the
thing to add first.

Two more forces set the shape:

- **ADR 0046 already built the hard half.** The authorization-request inbox is
  implemented: CIBA-shaped `auth_req_id`, RFC 9396 `authorization_details`, a
  canonical `requestDigest` an approval must echo, `inbox_…` handles so knowing
  a principal id is not enough to put text in front of somebody. What it has no
  concept of is *a link you can hand to another device*.
- **ADR 0058 already made OpenSesame a holder.** The native authenticator is an
  OID4VP/OID4VCI wallet via Multipaz. What the server side cannot do is *ask*
  a wallet for a proof and bind that proof to a specific operation.

So the gap is not "support Google Wallet". It is: there is no single object
that says *this specific question is waiting on another device*, and without
one, every new presentation surface is a new authorization system.

## Decision

### 1. One canonical interaction, addressed by an opaque reference

`Interaction` (`packages/os-domain/src/interaction.ts`) is the envelope for
every cross-device handoff. It has one state machine
(`machines/interaction.ts`), one set of terminal states, and one definition of
expiry, for all six kinds — `device_authorization`, `pairing`, `claim`,
`grant_claim`, `authorization_request`, `transaction_authorization`.

It **fronts** a ceremony; it does not replace one. The device-authorization
session, the authorization request and the claim session keep their own rows
and their own machines. `InteractionSubject` names which one. This is
deliberate: those machines encode domain rules the envelope does not know, and
collapsing them into a single table would lose the very distinctions ADR 0009
insists on.

A reference (`i_<base64url-id>.<mac>`,
`packages/os-domain/src/crypto/interaction-ref.ts`) is what goes on a screen.
It is unguessable (18 random bytes) *and* MAC-bound, which do different jobs:
randomness stops enumeration, and the MAC means a fabricated reference is
refused before any database lookup, so the resolve endpoint cannot be turned
into a probe and "malformed", "forged" and "no such interaction" are one
answer at one cost.

### 2. HTTPS is canonical; custom schemes are compatibility adapters

The canonical form is `https://<host>/i/<ref>`. Not a custom scheme: a scheme
cannot be opened by a camera app, cannot be a Wallet barcode value that
degrades gracefully, and cannot be verified by the browser's origin model.
`opensesame://`, `opensesame-mfa://`, `openid4vp://` and `?user_code=` links
remain **parseable** (`parseLegacyInteractionLink`) so links already printed
keep working. They are not a second canonical format.

The JSON API mounts at `/v1/interactions`. Note the collision hazard:
`/interaction` (singular, no version prefix) is the oidc-provider login/consent
surface (`apps/control-plane/src/app.ts:141`) and is a different thing
entirely. The version prefix is what separates them; do not add
`/interactions` unversioned.

### 3. The reference authorizes nothing

Resolving one returns `InteractionSummary`: kind, status, expiry, and whether
an approver is required. Enough to render "someone is asking you to approve a
device — sign in to continue", and nothing that tells a finder of a
photographed QR who is asking whom for what. `InteractionDetail` — requester,
binding message, authorization details, digest — needs an authenticated
approver.

Scanning is not approving. `present` is an idempotent display fact with its
own state, precisely so that "opened on another device" can be shown to the
requester without anyone ever wiring it to consent.

### 4. The digest is the whole point

`canonicalRequestDigest` (`crypto/request-digest.ts`) hashes kind, approver,
requester, `authorization_details`, binding message, resource, **and the
expiry window**, each field length-prefixed. `approve()` refuses a proof whose
`boundDigest` is not the interaction's digest.

    displayed operation == approved operation == executed operation

A WebAuthn assertion proves a key was touched; a verifiable presentation proves
a credential was held. Neither says what was agreed to. This is PSD2 dynamic
linking (EU 2018/389 RTS Art. 5) generalized past payments, and it is the same
invariant ADR 0046 §2 states for relayed execution — the same discipline, now
reachable from a phone.

The window is inside the digest because an approval is for an operation *and*
for how long it stays good; leaving it out would let a five-minute grant be
approved and an eight-hour one executed.

### 5. Wallet providers are presentation adapters, and Google is one of them

`WalletPassProvider` (`packages/wallet`) has three methods and no vendor types
in its signature. A Google Wallet Generic Pass carries a barcode whose value is
the canonical interaction URL and nothing else.

Three consequences, each of which must stay true:

- **Google is never an authority.** Possession of a pass is possession of a
  reference, which authorizes nothing (§3). A pass cannot substitute for a
  cryptographic approval because approval requires a proof bound to the digest,
  and a pass carries no key.
- **Google is never a dependency.** Wallet configuration is optional. With no
  Google credentials the provider reports `available: false` and the QR/PWA/
  browser path is untouched. A Google outage cannot weaken authorization
  because nothing in the approval path calls Google.
- **A pass is never a credential store.** `assertPassPayloadSafe` runs on every
  issued pass in production, not only in tests, and refuses tokens, claim
  tokens, JOSE, PEM, PANs and forbidden parameter names anywhere in the
  serialized object.

Revoking a pass and revoking an identity are separate operations, in that
order of blast radius.

### 6. Payment authorization, never payment credentials

A `payment_initiation` authorization detail expresses *permission to initiate
a payment-like operation*: an amount, a currency, a payee display name. The
amount is a decimal **string**, because a JSON number cannot round-trip
`143.72` and a digest computed over a float would disagree with the screen for
reasons no reviewer would ever find.

Card data is refused mechanically (`assertNoPaymentCredentials`), by field name
*and* by Luhn-checking string values, so a PAN under an innocuous key is
refused too. The refusal names the path and never the value.

OpenSesame does not issue cards, provision DPANs, tokenize on a network, acquire
for merchants, or store PAN/CVV. This is not a gap to fill later; touching card
data would pull the whole system into PCI DSS scope for no product reason.

### 7. A proof records what the server established, and nothing more

`ApprovalProof` keeps the mechanism, the bound digest, the assurance level and
a timestamp. No assertion bytes, no verifiable presentation, no JOSE — those
are verification *inputs*, checked at the protocol boundary and dropped. What
survives is what an executor needs and what is safe in an audit row.

**Every field of it is server-derived.** The first implementation took the
whole proof from the request body, and an adversarial review demonstrated the
consequence: an authenticated caller could write `mechanism: "webauthn"`,
`assurance: "phishing_resistant"` into storage and the audit trail having
touched no key at all. The repository's own test helper did exactly that, and
every test passed. A record that overstates what was checked is worse than no
record, because it is the record a reviewer believes.

So `/v1/interactions/{ref}/approve` accepts the digest echo and nothing else.
The mechanism is the one thing the route verifies — an authenticated session —
and the assurance is read from the approver's principal record.

**What this means today, stated plainly:** the approve route does not verify a
WebAuthn assertion or a verifiable presentation. `/v1/mfa/*` really does verify
passkey assertions and TOTP codes, but nothing binds a verification there to a
specific interaction here, so claiming a stronger mechanism would be a claim
about a link that does not exist. Making that binding — a step-up whose result
is scoped to one interaction's digest — is what would let a stronger mechanism
be recorded honestly. Until it exists, none is.

An authenticated session is therefore *currently* what an approval rests on,
above the digest binding. That is weaker than this ADR originally asserted, and
saying so is the point: a design document that describes a ceremony the code
does not run is how the gap survives review.

## Consequences

**Load-bearing.** The digest check in `approve()` is what makes every approval
in this system mean something. Weakening it — accepting a proof without a
digest, comparing prefixes, letting the repository patch `requestDigest` —
turns the entire interaction layer decorative. The repository patch type is
narrowed for exactly this reason.

**One live interaction per ceremony.** A partial unique index on
`(subjectKind, subjectId)` where status is non-terminal. Two QR codes for one
device-authorization session would mean two references a photograph could
capture, and only one of them revocable by the obvious action.

**Terminal states never reopen.** This is what makes a photographed QR useless
after the fact: the reference still resolves, and it resolves to `consumed`.

**Concurrency is the store's job.** `consume()` states the rule; the
`updateWithVersion` compare-and-set is what actually serializes two racing
executors. An application-level check alone would double-execute.

**Surface parity is a merge gate.** Every new route, CLI verb and PWA action
here needs a `packages/capability-registry` entry mapping or ADR-excluding it
across MCP/WebMCP (ADR 0065).

**What this does not do.** It does not merge the Identity and Host APIs
(ADR 0017 stands). It does not replace the ADR 0046 inbox — it gives it a link.
It does not make OpenSesame an issuer of anything it was not already.
mdoc/CBOR verification, Apple Wallet, and live OpenID Foundation conformance
are named as unsupported in `docs/protocol-conformance.md` rather than stubbed,
because a typed refusal is worth more than a happy path that cannot run.
