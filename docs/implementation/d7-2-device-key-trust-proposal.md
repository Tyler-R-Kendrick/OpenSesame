# D7-2 proposal: how the daemon first trusts a CLI device key

**Status:** Draft for Tyler review — do not implement until confirmed.

**Context:** Round 7 D7 stack, CLI ↔ PWA integration (ADR 0186). Pairing
`confirm` already binds a P-256 device key (SPKI) to an origin and pairing
code (`crates/cli-app-integration`, `pairing_confirm_message`). This note
proposes the **first-trust** story: what the daemon accepts before any bearer
exists.

## Requirements (Tyler binding)

1. Same-machine approval stays **local** (loopback UDS / loopback TCP); no
   relayed human proof for pairing confirm.
2. **`humanProof`** on approve/deny is a passkey or PIN check the **daemon can
   verify** (not env markers, not client-asserted booleans).
3. **Pairing confirm** runs only while the **vault is unlocked** in the PWA
   (unlocked app, person present).

## Proposed mechanism

### 1. Challenge-bound device key (existing)

Keep the current confirm signature:

- Daemon issues `pairing_challenge` per pending code.
- PWA proves possession of a **new** P-256 key: signs
  `pairing_confirm_message(challenge, code, origin)` with the private key
  matching submitted SPKI.
- Daemon stores `(origin, spki_fingerprint)` only after verify; wrong origin
  or bad sig → `pairing_refused` (see `pairing_tests.rs`).

**First trust** = first successful confirm for that origin establishes the
device key line for subsequent `register_webauthn` / bearer mint.

### 2. Unlocked-app gate (PWA, new)

Before calling `POST …/pairing/confirm`, the PWA must:

- Hold an **unlocked vault** session (not guest tomb isolation for pairing UI).
- Complete **humanProof** via the same unlock material the daemon already
  accepts for `respond` (PIN wrap verification or passkey assertion forwarded
  to daemon verify endpoint).

Daemon adds a **confirm-specific** route or extends confirm body with
`humanProof` + `respondNonce` tied to the pending pairing row (single-use,
short TTL). Confirm without unlocked proof → `403 pairing_refused`.

### 3. Operator mint path (unchanged)

Operator pairing codes (`POST /v1/operator/cli-app-integration/pair`) remain
the bootstrap for origins without an existing bearer; device key confirm still
required before exchange.

### 4. No trust from client env

Reject any design that trusts `OPENSESAME_*` markers, TTY alone, or PWA-local
flags without daemon-verified humanProof.

## Open questions for Tyler

1. Should the **same** device key be **stable per browser profile** (stored in
   tomb) vs **fresh per pairing** (current tests use ephemeral keys)?
2. On confirm, is **SPKI thumbprint** enough to pin re-pair, or should the
   daemon also store a **vault principal** thumbprint from the unlocked session?
3. TCP loopback pairing: keep **per-attempt correlation id** only (no session
   reuse), or allow device-key bearer to span commands after exchange?

## Suggested implementation slices (after approval)

1. Daemon: confirm handler requires `humanProof` + unlocked proof verification.
2. PWA: Pair CLI / Terminal CLI flows block until vault unlocked; wire proof.
3. Conformance vectors in `spec/conformance/cli-app-integration.json`.
4. Persona journey: pair → approve reveal on same machine.
