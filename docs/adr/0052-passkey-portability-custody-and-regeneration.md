# ADR 0052 — Passkey portability, custody, and regeneration

Status: Accepted
Date: 2026-08-22
Supplements: ADR 0005 (ConnectionRef and materialization levels), ADR 0048
§D4 (capability preference), ADR 0049 (derived materialization); extends the
human vault surface described in ADR 0037/0038

## Context

A passkey is the first credential class a password manager can genuinely
*own*. A password is a string: the user can read it, retype it, and take it
anywhere. A passkey's private key is generated inside an authenticator that
is built never to release it — which is the property that makes passkeys
phishing-resistant, and the same property that makes them a lock-in
mechanism. A user with two hundred passkeys in a platform keychain has two
hundred reasons not to switch, and no export button will ever appear that
changes the arithmetic, because the key is non-extractable by construction.

OpenSesame exists to keep humans in control of their own authority, so it
has to answer this directly. Three answers get proposed, and only two of
them are real:

- **Broker the foreign passkey** — have OpenSesame stand in front of a
  credential held by 1Password/iCloud Keychain/Bitwarden and satisfy WebAuthn
  ceremonies on the user's behalf. This is not implementable. Satisfying a
  ceremony requires signing with the private key, and the holding manager
  will not release it to us any more than it will release it to the user.
  Nothing about being a "broker" changes the cryptography.
- **Move the credential** — possible exactly when the holder cooperates.
  The FIDO Alliance's Credential Exchange Format/Protocol (CXF/CXP) is that
  cooperation, and the major managers have begun shipping it. Where an
  export exists, a passkey is portable like anything else.
- **Regenerate the credential** — enroll a *new* passkey at the relying
  party under OpenSesame's custody, then retire the old one at the RP. This
  works everywhere, needs no cooperation from the incumbent, and is what
  users actually mean when they say they want to "move" a passkey they
  cannot export.

Meanwhile the repository already holds most of a credential-hygiene engine
and has never connected it. `apps/pages/src/lib/vault/health.ts` finds weak,
reused, and stale passwords and then offers the user a link to an edit form.
`crates/rotation` is a proof-verified rotation state machine with no caller.
`crates/connection-broker/src/rotation.rs` exposes `policy_due_at()` for a
scheduler that was never written. Apple Passwords' auto-update of weak
passwords is the product shape being asked for; the parts to build it are
sitting in the tree unwired.

The hard constraint on that last piece is ADR 0005. An agent never resolves
secret material, and an LLM is an agent. Any "AI updates your credentials"
feature that requires a model to see a password or a private key is
disqualified before it is designed.

## Decision

### 1. The vault takes custody of passkey private keys

`PasskeyItem` in the human vault gains optional private-key custody
(`privateKeyPkcs8B64`, plus `cosePublicKeyB64`, `signCount`, `userHandleB64`,
`discoverable`, `alg`, `transports`). The key rides inside the sealed body,
under the same E2EE envelope and the same handling rules as
`CertificateItem.privateKeyPem`, which is already precedent for private-key
custody in this vault. No server plane can read it: the vault root key never
leaves the client.

Every passkey item carries `custody: "vault" | "external"`. `external` — the
default, and what every pre-existing item deserializes to — means the private
key lives in some other authenticator and the item is a record of a
credential we cannot use. `vault` means OpenSesame is the authenticator.
Provenance (`imported` | `generated` | `recorded`) and `importedFrom` are
retained so the UI can be honest about where a credential came from.

### 2. Brokering foreign passkeys is rejected, permanently

OpenSesame will not claim, imply, or build toward proxying WebAuthn
ceremonies for credentials held by other managers. When the user keeps using
a foreign passkey through its holder's cross-device (hybrid CTAP) flow, that
is the *holder's* ceremony; OpenSesame records that the credential exists and
that it is not ours. **Tracked state, never a proxy.** Any future UI copy
that suggests otherwise is a bug against this ADR.

### 3. CXF import first, export symmetric, CXP deferred

OpenSesame parses FIDO Credential Exchange Format JSON, plus the native
export formats that already carry passkey keys (Bitwarden JSON
`fido2Credentials`, 1Password 1PUX, Proton Pass JSON — the last of which we
currently count and discard). Imported credentials land as `custody: "vault"`,
`provenance: "imported"`.

Export is symmetric. A user must be able to leave OpenSesame carrying the
passkeys they brought and the ones we generated, in CXF, or the position
above is hypocrisy rather than principle. Portability is a property we owe
the user, not a moat.

CXP — the *online* exchange protocol, where two managers negotiate a transfer
directly — is deferred until ecosystem endpoints exist to negotiate with. The
format work lands now; the protocol work waits for a counterparty.

### 4. Regeneration is the answer for everything that cannot move

For a credential that cannot be exported, OpenSesame drives a **re-enrollment**:
generate a new passkey at the relying party under vault custody, confirm it
works, then retire the old credential at the RP. The vault keeps the retired
item (`supersededById`, `retiredAt`, `reenrollState`) rather than deleting it,
because "did I actually remove the old one" is a question users need answered
months later.

Where the RP publishes `/.well-known/change-password` (RFC 8615), that is the
entry point. Where it does not, the flow is a per-RP checklist. This is
deliberately unglamorous: there is no way to make a third party's account
settings page programmatic, and pretending otherwise produces a feature that
silently fails.

### 5. Relying-party capability data ships in the bundle, never over the network

To tell a user "this site supports passkeys, you are still using a password,"
we need to know which RPs support passkeys. That dataset ships as a checked-in
static file refreshed by a scheduled agent routine. The vault does not call
out to a capability service, for the same reason `health.ts` does not call a
breach service: the health report's privacy stance is that *the report never
tells anyone what is in your vault*, and a lookup is a disclosure.

### 6. AI orchestrates; deterministic code holds the secrets

The credential-health automation is bounded by ADR 0005, restated concretely:

- **What the AI layer may see**: issue codes (`weak`, `reused`, `old`,
  `foreign-passkey`, `passkey-eligible`, `retirement-pending`), relying-party
  identifiers, `ConnectionRef`s, rotation job states, timestamps, and failure
  counts.
- **What it may never see**: passwords, private keys, TOTP seeds, derived
  tokens, or any sealed body content. `RotationJob::public_view()` already
  strips these server-side and `apps/worker/src/rotation.ts` already asserts
  it; both fences stay.
- **Who generates secret bytes**: deterministic code only — the CSPRNG
  generators in `apps/pages/src/lib/vault/password.ts` and
  `crates/sealed-store/src/generate.rs`, and WebAuthn ceremonies. A model
  never authors a credential.
- **Where the AI layer runs**: as a Claude Code Routine
  (`ops/routines/`), consistent with the repository's existing automation
  substrate. No runtime LLM dependency is added to any shipped binary, and no
  GitHub Actions are introduced.
- **Client-side findings stay client-side.** Vault health is computed over
  decrypted items in the browser and does not leave the device. A user may
  explicitly opt to export a *redacted* task list (relying-party identifiers
  and issue codes, no usernames, no secrets) for the routine to schedule
  around; that is a consent ceremony, not a default.

### 7. Automatic and assisted are a user choice, and capability decides the ceiling

A setting, `rotationMode: "auto" | "assisted"`, is chosen globally and
overridable per item and per connection.

- `auto` — capability-backed rotations run end-to-end without pausing, and
  deterministic client-side steps auto-advance.
- `assisted` — every ceremony halts at a consent step before anything
  changes at the relying party.

Capability sets the ceiling regardless of mode, following ADR 0048 §D4:
**MINT** (ADR 0049 derived materialization) rotates fully automatically;
**INVOKE-THROUGH** rotates through the existing broker under its egress
fences; everything else terminates in a `needs-human` state and surfaces as a
guided task. `auto` is a statement about *consent*, never a licence to invent
a capability the provider does not offer. Sealed-store targets stay
agent-hostile per ADR 0037: an agent may propose a rotation, but the human
CLI seals it.

### 8. The extension becomes a WebAuthn provider, scoped narrowly for v1

Vault-custodied passkeys are only useful if a relying party can actually use
them, which requires a `navigator.credentials` provider surface in the
browser extension. For the first landing:

- Chromium MV3 only, **off by default**, opt-in per user.
- The relying-party identifier is taken from the content script's
  `sender.origin`, never from the page's claim, and validated with the
  rpId/host-suffix rules already written in
  `apps/pages/src/lib/vault/unlock-methods.ts`.
- Top-level, same-origin rpId-suffix only. Cross-origin iframes and Related
  Origin Requests are out of scope for v1.
- Signing happens in the Pages origin, which already holds the vault unlock
  paths; the extension relays and hosts the consent ceremony. Moving the
  authenticator into an extension-held synced vault is a documented
  follow-up, not the first cut.
- `signCount` is always 0, the multi-device-credential convention. A synced
  credential cannot maintain a meaningful monotonic counter across devices,
  and emitting a fabricated one invites false clone-detection failures at
  relying parties — the same class of bug
  `docs/security/audit-2026-08-08-passkey-counter-device-fence.md` fixed on
  the server side.
- Serving a provider requires a `https://*/*` content-script match. This is a
  real expansion of the extension's surface — it holds `storage` and `alarms`
  today — and is accepted deliberately, with host permissions for the Host
  API staying loopback-only.

## Consequences

- OpenSesame can honestly tell a user: passkeys you can export, we will
  carry; passkeys you cannot, we will help you replace; passkeys you keep
  elsewhere, we will track but never pretend to control. Each of those is
  true, which is not the case for any product claiming to "bring your
  passkeys with you."
- The vault now holds a second class of private key. Every path that logs,
  serializes, or exports an item must treat `privateKeyPkcs8B64` the way it
  treats `privateKeyPem`; the redaction lists in `packages/observability` and
  `apps/worker` are updated, and the boundary is a permanent review item for
  the security audit series.
- Rotation gains durability it never had. Policies and jobs move from a
  process-local registry to persisted tables modeled on
  `migrations/0008_backup_outbox.sql`, and `crates/rotation`'s proof-verified
  state machine becomes the spine of the broker's execution path rather than
  an orphan.
- The `needs-human` terminal state is a permanent fixture, not a gap to close
  later. Most relying parties will never expose a rotation API, and a design
  that treats manual completion as a failure mode would misreport the
  majority case.
- The extension's `https://*/*` match will attract store-review scrutiny and
  is a meaningfully larger attack surface than the extension has today. The
  compensating controls are the origin-authority rule, the opt-in default,
  and `pnpm test:redteam` coverage of the new message-passing boundary.
