# ADR 0186 — Trusted contacts: a quorum approves, or holds a share of, what you cannot do yourself

- **Status:** Accepted (behaviour built and verified; the ceremony screens are not part of this change)
- **Date:** 2026-10-10
- **Uses:** [ADR 0086](0086-wallet-native-interaction-layer.md) (an approval means what its digest says), [ADR 0087](0087-vault-item-type-plugins.md) (item types are manifests), [ADR 0090](0090-static-frontend-complete-without-backend.md) (no backend in front of the first screen), [ADR 0130](0130-operator-controlled-capability-composition.md) (optional capabilities), [ADR 0139](0139-one-definition-every-target.md) (one definition, every target), [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing stored in the clear), [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts or is absent), [ADR 0178](0178-authorization-checks-are-proofs-the-compiler-can-see.md) (authorization is a proof)
- **Related:** the duress recovery ceremonies (`packages/app-core/src/lib/duress/recovery/`), which solve a neighbouring problem with a shared-secret approval ledger

## Context

An owner can be unable to act: a lost device, an illness, a death. The usual
answer is *emergency access* — one trusted contact, a waiting period, the
owner's veto. It has one weakness this ADR exists to remove: **the one contact
holds the whole authority**, so one friend or relative who turns malicious (or
is phished, or is coerced) is enough.

Three things get called "a quorum", and they are not the same:

| | What the contacts contribute | What it enables | Limit |
|---|---|---|---|
| **Secret sharing** | shares of a recovery key | recovering a key | whoever recombines it holds the key afterwards |
| **Quorum approval** | independent approvals of one request | an action by a party that enforces the policy | needs that enforcer to be honest and to be there |
| **Threshold use** | partial computations | using a key without ever holding it | needs protocols ordinary security keys do not run |

The static client has no server (ADR 0090). Whatever enforces a policy is a
browser that holds the resource, or the contacts' own devices.

## Decision

OpenSesame gains an **optional** capability, `sharing.trusted-contacts`
(default off, no egress), that implements the first two as separate mechanisms
a policy composes, and deliberately not the third.

### 1. A guardian is a person; keys are alternatives

A *circle* names guardians. Each guardian has one or more security keys
(WebAuthn credentials). Everything is counted by guardian: a backup key
restores **availability** and casts no second vote, and a credential may
belong to exactly one guardian (`policy.ts`). Guardians sit in groups with a
member threshold each, and a group threshold sits over the groups — "3 of 5",
or "2 of 3 family **and** 2 of 4 friends". A guardian holds one share and so
sits in one group. A guardian chooses to be one: enrollment is signed by each
of their keys (`enroll.ts`), and the owner verifies the signatures before the
guardian is in the policy.

The policy is signed by the owner's Ed25519 key. Guardians pin that key when
they accept the invitation and check every request against the policy they
**hold**, never against what the requester sends: timings are the policy's, the
sentence is derived from the request's fields, and the recipient is whatever
the digest says.

Legal but risky policies are warned about, not refused: a single guardian, a
unanimous group (one lost key blocks recovery), no delay, approval by touch
alone, a quorum that fits inside one household.

### 2. Standards, and what each one is used for

| Standard | Used for | Verified by |
|---|---|---|
| **SLIP-0039** (Final) | the share format: GF(256) Shamir with a digest at f(254), RS1024 checksum, the 1024-word list, the PBKDF2 Feistel encryption of the secret, two-level groups | all **45** vectors of the standard (`spec/conformance/slip39/vectors.json`, MIT, SatoshiLabs), a drift test against the vendored wordlist, and round trips |
| **RFC 9180 HPKE**, base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM or ChaCha20-Poly1305 | sealing a released share to the recipient the request names | every intermediate value of Appendix **A.1 and A.2** — key pairs, shared secret, key schedule, nonces and ciphertexts through sequence 256, exporter values (`spec/conformance/hpke-rfc9180-vectors.json`, parsed from the RFC text by script) |
| **WebAuthn** assertion verification | a guardian's approval is an assertion over the request | challenge, origin, `crossOrigin`, RP ID hash, user presence, user verification (policy), signature counter, ES256 (high-S and leading-zero DER included) and Ed25519 signatures |
| **WebAuthn PRF extension** | wrapping a share under a key only the guardian's authenticator reproduces (PRF → HKDF → XChaCha20-Poly1305) | stability proved by a real round trip at hand-over, not by a capability flag |
| **ADR 0086's digest discipline** | the request digest: length-prefixed fields, canonical JSON (sorted keys, integers only), a purpose string, the validity window inside the digest | determinism, framing and purpose-separation tests |
| NIST SP 800-63B-4 | recovery contacts are a recognised recovery road; its notice and re-verification expectations are the UI's to meet | (informative) |
| ISO/IEC 19592 | the secret-sharing terminology; SLIP-0039 is the mechanism | (informative) |
| ERC-7093 (Draft) | the *separation* of guardian identity, policy evaluation and the operation it unlocks — followed as a design reference, not a wire format | (informative) |

**Not used, on purpose:** FROST (RFC 9591, Informational), ROAST,
Dynamic-FROST, ANARKey and post-quantum threshold signatures. Ordinary
security keys cannot be FROST participants, and nothing here needs a
distributed signature. They are the right tools for a later *repeated joint
signing* feature; none is half-built here.

### 3. A request is one thing, said once

A request carries the circle, the policy digest and epoch, the operation, its
scope, the recipient's X25519 key (a fresh one, made for the request), and
three instants: when approvals close, when a share may first be released, and
when the request lapses. Its digest is the value every approval is bound to.
The WebAuthn challenge is a hash of the **phase** and the digest, so an
approval assertion cannot be offered as a release, nor one request's approval
for another's.

Operations: `recover-collection` (release shares), and the action-only
`grant-access`, `export-items`, `replace-owner-credential`. A `grant-access`
request **carries the grant itself** — principal, resource, policy, duration —
in the same shape the share ledger writes, and its sentence is built from it.

### 4. Two clocks

Gathering approvals and objecting to them are different jobs and have
different settings. The **approval window** is short and coordinates a
ceremony. The **release delay** is long and gives the owner time to notice and
cancel. A guardian's device refuses to release a share before the delay, since
a quorum with shares in hand could otherwise skip it; the ledger refuses a
release that arrives early as well. An owner-signed cancellation stops a
request in any ledger that hears of it, and a guardian's device that has heard
of it refuses.

### 5. Releasing a share

Approval and release are separate steps by the same guardian. **Each
guardian's own device checks the quorum before it releases**: it is shown the
approvals, verifies each assertion itself, and refuses unless its own guardian
approved and the approvals satisfy the policy. A recipient's ledger is the
recipient's own, so a recipient who is the attacker will not enforce "a quorum
first"; the guardians' devices do, and the ledger repeats the rules as defense
in depth. A signature carries no time, so the approval window is kept by the
device that signs (it refuses to approve late) and by the ledger that receives;
the check at release replays the approvals as of the instant the request was
raised. A release unwraps
the guardian's share with their key (a PRF touch), seals it to the request's
recipient with the request digest and guardian id in the AAD, and returns it.
Only the recipient opens it, and a ciphertext cannot be lifted into another
request. The signed policy carries a **commitment** to each guardian's share,
so a forged or garbled release is caught per guardian, by name, instead of as
an anonymous failure at the end. Recombination takes exactly the shares
SLIP-0039 asks for. A signature cannot cover the share sealed after the touch,
so anyone relaying a release can damage it; a release that does not open, or is
not the committed share, is **dropped from the ledger** (the guardian can
release again) and the next combinable set from the releases already in hand
is tried, so one damaged packet cannot stall a recovery or burn a guardian's
one slot. The shares are written with an **empty passphrase**, so any
conforming tool recombines them without OpenSesame — the exit door.

### 6. Action-only circles and the share ledger

A circle that governs no `recover-collection` holds no secret: no shares, no
bundle, no commitments, and its guardians' keys need no PRF. A quorum-approved
`grant-access` becomes a standing share through the existing share ledger, and
only through a proof: `QuorumApproved<T>` (`proofs/quorum-approved.ts`) is the
third `ShareWriteAuthority`, beside `ManageGrants` and `SystemShareWrite`,
minted from the ledger's plain-data verdict (state `authorized`, operation
`grant-access`, not lapsed). `grantFromQuorum` takes **no share of its own**:
it writes the one in the approved request, once (`claimExecution`). A quorum
can grant access to a **person**; agents and applications stay behind the
owner's own approval. `savePendingShare` still demands `ManageGrants`, so a
quorum cannot queue anything else. `share-write.mistakes.ts` pins the misuse
that must not compile.

### 7. Item types

`trusted-circle` (the owner's record: rule, state, contacts, the signed policy,
and the owner's signing key as the concealed secret) and `guardian-share`
(what a guardian holds for someone else: the signed policy, their **wrapped**
share as the concealed secret, and their receiving key) are **optional
marketplace types** (`marketplace/item-types/optional/`, pinned in
`.opensesame/marketplace.json`). They are not built in: built-in types are
embedded in the Rust crate and belong to `vault.derived-records`, and these
belong to this capability. `records.ts` maps the engine to and from their
values; both project onto a `pass` entry whose line one is the concealed
secret. No plaintext share and no SLIP-0039 mnemonic is ever in a record.

### 8. The capability

`sharing.trusted-contacts` is an optional capability in the Sharing section:
default off, `keyAccess: item-plaintext, protector-wrap`, no egress. Its code
is `packages/app-core/src/lib/quorum/`, classified as owned by it; the
bootstrap does not import it. **It has no surface yet**: the module registers
nothing and the id is in `NO_SURFACE`, exactly as `sharing.household` is, so
Settings draws no switch (ADR 0158) until the ceremony screens exist. An
operator can still name it in a policy, prohibit it, or leave it out of a
distribution.

### 9. Changing a circle is a new epoch

Refreshing the shares, replacing a guardian, adding one and changing the rule
are one operation, `reissueCircle` (`epoch.ts`): the owner signs a **new
policy** one epoch later that names the digest of the one it replaces
(`supersedes`, checked by `assertPolicySound`: epoch 1 replaces nothing, every
later epoch names the one before), draws a **fresh recovery secret**, seals the
payload again under it, and deals every guardian in the new roster a new share.
Nothing is edited in place.

- *Shares of different epochs never combine.* The secret is new, so a guardian
  who was removed, or a share that leaked, opens nothing of the new bundle; a
  share of each epoch does not even recombine (the SLIP-0039 digest fails).
- *It does not take back what the old quorum could already read.* The old
  bundle is a file: whoever kept it and enough old shares can still open it
  (pinned by a test, so the limit stays stated). Replacing a guardian protects
  the future; a secret that was exposed still needs rotating at its provider.
- *A guardian never goes back* (`succession.ts`). Before a new policy replaces
  the one a device holds it must verify under the key pinned at the invitation,
  belong to the same circle and RP ID, and be **later**; the very next epoch
  must name the digest held. A device that was away for several epochs can check
  only the owner's signature on the one it is shown. An older or repeated policy
  is `rollback`; a delivery is checked this way before any key is touched
  (`acceptDelivery({ replaces })`), and a request for an old epoch is not one a
  device holding the new policy will sign (`checkRequest`).
- *Who stays and who goes.* `applyEpoch` answers a guardian: `retired` (not in
  the new roster: drop the share, they get no delivery), `awaiting_share`
  (take the new share, then delete the old one) or `adopted` (an action-only
  circle has no share, so the new policy is simply held).
- *What stays fixed*, because guardians' keys are registered against it: the
  circle id, the RP ID, and the receiving key of anyone who stays. A person who
  lost their device enrolls again as a new guardian and the old entry is retired.
- A request in flight at the old epoch is abandoned: the new policy's digest is
  in every request, so approvals do not carry across.

## What this does not do

State these to the people who rely on it.

- **A quorum is delegated authority.** Fewer than the threshold learn
  nothing; the threshold has everything the policy gave it. Colluding guardians
  are not defended against beyond the threshold and the delay.
- **A released share is visible to the guardian's browser.** PRF returns its
  output to the page, so a compromised guardian device **during a release** sees
  that one share. Hardware protects it at rest.
- **The delay is kept by honest devices and a ledger's clock.** An offline
  recovery page cannot enforce a delay against a quorum that already holds
  shares; the static shares carry no timing. A cancellation reaches only ledgers
  and guardians that hear of it.
- **Changing guardians does not erase old shares.** A new epoch (§9) deals new
  shares and the old ones open nothing of the new bundle, but they still open
  the old bundle if someone kept it. Rotating a wrapping key does not rotate
  the secret; a secret already revealed needs rotating at its provider.
- **A quorum approval is not a downstream session.** A service that issues its
  own bearer session outlives it.
- **No consensus.** Mutable policy (revocation, owner replacement) needs a
  serializing authority; an old owner-signed policy proves only what was
  authorized then.
- **The recipient's key is a person's to check.** A request names the key the
  shares are sealed to, and every guardian is shown its fingerprint. That it is
  the owner's new device is something the guardian must confirm by another
  road; nothing in the protocol can.
- **Credentials are bound to an origin.** A guardian's keys are registered
  under the circle's RP ID and origins. Losing that domain strands them.
- **Not exercised against physical hardware yet.** The tests drive a virtual
  authenticator that produces real WebAuthn artifacts, including the PRF
  derivation as the specification defines it. A pass against a physical YubiKey,
  and against platform passkeys, in Chrome, Safari and Firefox is the first
  follow-up.
- **WebAuthn verification covers the steps listed in §2,** not every optional
  step of the specification (no attestation, no `userHandle`, no extension
  outputs beyond PRF).
- **The `pass` entry of a record keeps the wrapped share on line one.** It is
  ciphertext under the guardian's key, marked concealed, and never a mnemonic.
- **Recovery refuses a share asking for more PBKDF2 work than exponent 6**
  (about 2.5 M iterations a round); the kernel itself accepts the standard's 15.

## Verification

- `pnpm --filter @opensesame/app-core exec vitest run src/lib/quorum` — 179
  tests: the SLIP-0039 and HPKE vectors; an end-to-end 3-of-5 with a backup key;
  two-level recovery; action-only circles; a quorum grant against a real vault
  tomb; the attacks (wrong request, wrong phase, replayed or forged assertion,
  wrong origin or RP ID, no user verification, a counter that stands still,
  early release, a lapsed window, a forged share, a request that lies, a
  cancellation, a second use).
- **Mutation check.** Each security check was disabled in turn and the suite
  required to fail — 27 mutants: challenge, signature, origin, RP ID hash,
  presence, verification, counter, assertion type, cross-origin, duplicate
  guardian, the ledger's quorum, approval and delay checks, the guardian
  device's delay, own-approval, quorum and cancellation checks, request timing,
  derived sentence, phase-in-challenge, the recipient's and the guardian's share
  commitments, dropping a damaged release, the owner-key pin, the policy
  signature check when a ledger opens, once-only execution and persons-only
  grants. Mutants that first survived led to the direct WebAuthn tests, the
  device-side quorum tests and a test that a wrong delivery is refused before
  the guardian is asked to touch a key. Mutating the loop that drops a damaged
  release also showed it needed a bound; it has one.
- **Rust parity.** `crates/vault-item-types/tests/conformance.rs` parses every
  optional marketplace definition under community trust and round-trips its
  native projection, so both planes accept `trusted-circle` and
  `guardian-share` and agree on their `pass` entries.
- Existing share-ledger, receipts and proof tests pass unchanged; the type
  checker refuses the new misuse cases.

## Consequences

- One more optional capability, one owner proof, two marketplace item types,
  two conformance files. No change to the default bundle.
- The core share ledger now trails a quorum grant as a decision (receipt and,
  for a connector, the Access audit line), as it does a person's.
- The ceremonies need screens: invite and enroll, take a share, approve,
  release, recombine. Until then the behaviour is reachable by code only.

## Follow-ups

1. The ceremony screens (and their tutorials, evidence and keyboard/touch
   gates), then take the capability out of `NO_SURFACE`.
2. A hardware pass (YubiKey, platform passkeys) across browsers.
3. A Rust consumer of `spec/conformance/slip39` and
   `hpke-rfc9180-vectors.json`, for `opensesame pass` recovery export.
5. Optionally carry a request as an Interaction when an Identity API is
   configured; the digest framing is the same family.
