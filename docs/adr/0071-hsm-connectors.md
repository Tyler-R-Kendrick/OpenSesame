# ADR 0071 — HSM connectors via PKCS#11

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005 (authority handles), ADR 0032 §3 (catalog is data),
ADR 0048 §5 (dependency budget and daemon quarantine),
ADR 0052-cert ([key custody](0052-automatic-certificate-authority-selection.md)),
ADR 0066 (Certificate Manager domain model), ADR 0067 (CRL/OCSP signing),
ADR 0070 (code signing)
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

Every private key OpenSesame holds today is sealed at rest with
XChaCha20-Poly1305 under a purpose-scoped AAD (`seal_scoped` in
`crates/connection-broker/src/crypto.rs`, per ADR 0052-cert). That is a good
design and it has one irreducible property: at the moment of signing, the
plaintext key exists in the gateway's process memory. An attacker with code
execution in that process, or with a core dump of it, gets the CA key.

For a development root, acceptable. For the root of a hierarchy an organization
puts on its device fleet (ADR 0066), for the key that signs CRLs and OCSP
responses (ADR 0067), and above all for a code-signing key (ADR 0070), it is the
gap that separates "we manage keys" from "we protect keys". It is also the gap
compliance regimes ask about first, and the reason organizations buy hardware
security modules at all.

Adding hardware custody could be done two ways: as a special case wired into the
CA and signer code paths, or as a second implementation of one interface those
paths already use. The second is the only one that stays correct, and choosing
it is the substance of this ADR.

## Decision

### 1. A PKCS#11 client crate, reached in-process by the gateway

`crates/hsm-client` (forthcoming) wraps `cryptoki`, the maintained Rust binding
to PKCS#11 v2.40. It opens a session against an operator-configured module,
logs in with a sealed PIN, finds key objects by label, and performs signing
operations. It contains no HTTP, no storage, and no axum — it is a library over
a local shared object.

`cryptoki` rather than a hand-written FFI layer: PKCS#11 is a large C API with
sharp memory ownership rules, and hand-rolling it is the kind of NIH protocol
code ADR 0008 tells us to avoid, in a language boundary where the mistakes are
memory-unsafe rather than merely wrong.

The client lives in the **gateway** and nowhere near the daemon. `cryptoki`
loads a vendor shared object and is a substantial native surface; ADR 0048 §5's
daemon dependency budget stands, and `scripts/daemon-deps-gate.sh` keeps it out
of every daemon-adjacent tree.

Gate: `cargo +1.88.0 build -p opensesame-hsm-client`

### 2. The connector model: slot label, sealed PIN, optional key-label prefix

An `hsm_connectors` row carries:

| Field | Purpose |
|---|---|
| `label` | the token/slot label, unique per organization |
| `SEALED(sealed_pin)` | the login PIN, sealed under the `hsm_pin` scope |
| `module_hint` | which PKCS#11 module this connector expects |
| `key_label_prefix` | optional namespace applied to every key label |
| `gateway_ref` | optional: which gateway instance can reach this module |
| `status` | `unverified` / `verified` / `failed` |

**Slot by label, not by index.** PKCS#11 slot indices are assigned by the module
at load time and are not stable across restarts, firmware updates, or the
insertion of another token. A connector pinned to slot 3 silently addresses a
different token after a reboot — and the failure is not an error, it is signing
with the wrong key. Labels are operator-assigned and stable.

**PIN sealed, never echoed.** The PIN is written once, sealed with
organization- and connector-bound AAD, and has no read path: connector reads
project the row without it and there is no reveal ceremony. A PIN that can be
read back is a PIN in a support ticket.

**Key-label prefix** lets several organizations, or several purposes, share one
physical token without colliding in its flat label namespace. Applied on both
creation and lookup, so a connector cannot address a key outside its prefix.

The module path itself is **operator configuration on the gateway host**, not a
field in the connector row. A row that could name an arbitrary shared object
would be a request-body-driven `dlopen`, which is arbitrary code execution
dressed as configuration. The row names which module it expects; the operator
decides which modules exist.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 3. Supported mechanisms and key generation, deliberately narrow

Signing mechanisms:

- **RSA PKCS#1 v1.5** — raw (`CKM_RSA_PKCS`, caller-supplied DigestInfo) and the
  digest-combining forms for SHA-256, SHA-384, SHA-512.
- **ECDSA** with SHA-256, SHA-384, SHA-512.

Key generation through a connector:

- **RSA-2048** and **RSA-4096**
- **ECDSA P-256** and **P-384**

The raw RSA form exists because ADR 0070's Sign API takes a precomputed digest;
callers that have already built a DigestInfo need a mechanism that signs it
without re-wrapping.

The list is short on purpose. Every mechanism is one more shape to validate,
and the intersection actually supported across SoftHSM2, cloud HSMs and common
appliances is not much larger than this. Absent from it, and deliberately: RSA
PSS (support is uneven across modules and our issuance stack does not emit it),
Ed25519 (poorly and inconsistently supported in PKCS#11 modules today, even
though the software path supports it for leaves), and any key-wrapping or
key-extraction mechanism — a connector that can wrap a key out of the token
defeats the entire purpose.

Gate: `cargo +1.88.0 test -p opensesame-hsm-client`

### 4. HSM-held keys implement the same `Signer` trait as sealed keys

This is the architectural decision the rest of the ADR exists to support.

`crates/pki-core` (forthcoming) defines a custody-agnostic `Signer` trait:
given a digest and an algorithm, produce a signature; expose the public key and
the algorithm. Two implementations exist — one over a sealed key opened in
process, one over an HSM key label on a connector session — and **nothing above
the trait knows which it has**.

Consequently:

- CA issuance signs through a `Signer` (`certificate_authorities.key_source` is
  `sealed` or `hsm`, and the routes do not branch further).
- CRL generation and OCSP responses sign through a `Signer` (ADR 0067 §2, §6),
  so an HSM-backed CA signs its revocation data in hardware.
- The Sign API signs through a `Signer` (ADR 0070 §1), so a signer's
  `key_source` is a storage detail rather than a second code path.
- The PKCS#11 provider module of ADR 0070 §5 proxies to the Sign API, which may
  itself be backed by an HSM — a chain that composes only because the middle
  layer is custody-agnostic.

The rejected alternative was `if hsm { … } else { … }` at each signing site.
It is the version that decays: every new signing site is a new place to forget
the branch, and forgetting it in the direction of "assume sealed" means either a
failure or, worse, silently signing with a key that was supposed to be in
hardware. One trait, two implementations, no branches.

Migrating an existing sealed CA to HSM custody is **not** a supported in-place
operation, because it would require exporting the sealed key into a token — the
one operation the whole design refuses. An organization that wants an
HSM-backed root creates one and, if needed, cross-signs.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 5. Verify-on-create, PIN rotation, and consumer stability

**Verify-on-create.** Creating a connector, and generating a key through one,
performs a live round trip: open the session, log in, and — for keygen — sign a
test value with the new key and verify it against the public key the token
reports. Only then does `status` become `verified`. Discovering at first
CRL generation that a CA's key does not work is discovering it at the worst
possible time; the check costs one signature at configuration time.

**PIN rotation does not recreate consumers.** Rotating a connector's PIN is an
update to the sealed blob on the connector row. Every CA and signer referencing
the connector keeps referencing it by id, and none is touched. If the PIN were
part of each consumer's configuration, rotation would mean editing every CA and
signer that used the token, with a window in which some had the old PIN — and
operators would respond by not rotating. In-flight sessions using the old PIN
drain naturally; new sessions use the new one.

**Connectors and their credentials are excluded from every agent surface.**
`certmgr.connector.hsm` is excluded on `mcp_host`, `mcp_client` and `webmcp`,
matching the sync exclusion in ADR 0069 §2(d). Connector reads never project
the PIN.

Gate: `pnpm --filter @opensesame/capability-registry test`

### 6. SoftHSM2 is the CI validation target, and the honest limit of that

Integration tests run against **SoftHSM2**, a software PKCS#11 module: create a
token, generate keys, sign, verify, exercise label lookup and prefix scoping.
The suite is gated behind a cargo feature and an environment probe; where
SoftHSM2 is absent, it skips with a recorded limitation and a mock-token unit
test exercises the same code path over a fake session.

SoftHSM2 validates our use of the PKCS#11 *API*: call sequences, session and
object lifetimes, mechanism parameters, error handling. It validates nothing
about real hardware. Vendor modules differ in mechanism support, in threading
and session-limit behavior, in error codes, and in how strictly they enforce
attribute templates. A green SoftHSM2 suite means the code is API-correct, not
that any particular appliance works.

`docs/validation/certificate-manager.md` records this as a residual risk and
names operator acceptance testing against the specific module as the validation
obligation. Overstating it would be worse than having no HSM support, because an
operator would trust hardware custody they had not confirmed.

Gate: `cargo +1.88.0 test -p opensesame-hsm-client`

## Consequences

- CA keys, CRL/OCSP signing keys and code-signing keys can be held in hardware,
  so gateway process compromise no longer implies key compromise. It still
  implies *use* compromise for as long as the attacker holds the process — an
  HSM prevents exfiltration, not misuse.
- The `Signer` trait becomes a load-bearing interface. It is small, and every
  signing site in the certificate subsystem depends on it, which is exactly why
  it must not grow custody-specific methods.
- HSM keys can never be backed up by OpenSesame. Key ceremony, backup and
  disaster recovery for hardware-held keys are the operator's, via their module's
  facilities. Sealed keys remain covered by ADR 0039's snapshot path; this
  asymmetry is intentional and must be documented in the operator runbook.
- The gateway gains a native `dlopen` surface. It is operator-configured, never
  request-driven (§2), and stays out of the daemon under ADR 0048 §5.
- Hardware validation is deferred to operators. CI proves API correctness only.
