# ADR 0070 — Code signing: signers, the Sign API, and scoped approvals

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005
([authority handles / ConnectionRef](0005-authority-handle-connectionref.md),
which names `SignerRef`), ADR 0017 (host/client topology),
ADR 0048 §5 (dependency budget), ADR 0053 (default-off feature-gated surfaces),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0066 (Certificate Manager domain model), ADR 0071 (HSM connectors)
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

ADR 0005 enumerated the internal reference types the authority plane would
need — `CredentialRef`, `KeyRef`, `CertificateAuthorityRef`, **`SignerRef`**,
`SecretRef` — and `SignerRef` has had no implementation since. The plane it
names is real and unbuilt: an organization has code-signing keys, those keys are
the most consequential secrets it owns, and today they live in a developer's
keychain, a CI secret, or a USB token in a drawer.

Code-signing keys have a threat profile unlike any other credential OpenSesame
holds. A leaked API token buys an attacker access to one service. A leaked
code-signing key buys them the ability to make arbitrary software look like it
came from the organization, to every machine that trusts the certificate,
retroactively and until revocation propagates. The 2011 DigiNotar and 2020
SolarWinds patterns are both instances of it. The mitigation that actually
works is not "store the key more carefully"; it is **never letting the key
leave, and constraining what each use of it may sign**.

That is what this ADR builds: signers as authority handles, a signing API that
structurally cannot leak the key, and an approval model that pins each
authorization to the circumstances of a specific signing operation.

## Decision

### 1. A signer is an authority handle, fulfilling ADR 0005's `SignerRef`

A `signers` row is the concrete form of ADR 0005's `SignerRef`: a named,
organization-scoped handle to a signing key the caller can *use* and cannot
*hold*. It carries a name (unique per organization), exactly one certificate,
a `key_source` of `sealed` or `hsm`, a status
(`pending`/`active`/`failed`/`disabled`/`expired`), auto-renew settings, and —
for sealed custody — a `SEALED(sealed_key)` column group under the `signer_key`
scope.

The ADR 0005 properties hold verbatim. The handle is meaningless outside an
authorized invocation: possessing a signer id grants nothing. There is no
resolve, no materialize, no export — a signer's private key has **no read path
at all**, not even a human ceremony one. This is stricter than certificates,
where ADR 0052-cert allows a one-time acknowledged leaf delivery to the
authenticated creator. A code-signing key that can be exported is a code-signing
key that will be, and the whole value of the handle is that the answer to "can I
get the key out" is no, structurally, for everyone.

**One certificate per signer.** A signer whose certificate is rotated gets a new
certificate on the same signer (through auto-renew or an explicit renewal),
never a second concurrent one. Two live certificates on one signer would make
"which identity did this signature assert" ambiguous, and that question has to
have one answer for the activity ledger (§6) to be worth reading.

Signer membership is its own role set — `administrator`, `operator`,
`auditor` — resolved by the same helper that resolves application roles
(ADR 0066 §3, forthcoming `apps/gateway/src/routes/certmgr_roles.rs`), because a
signer is not owned by an application: the people who may sign a release are
usually not the people who manage that service's TLS.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 2. The Sign API takes a digest, never an artifact

`POST /api/v1/certmgr/signers/{id}/sign` accepts a **precomputed digest** plus
signing context, and returns a signature. It does not accept a file, a binary, a
multipart upload, or a URL to fetch. The body limit is 64 KiB and the digest
field is a fixed-length hex string validated against the declared algorithm.

Three reasons, in order of weight:

**No artifact custody.** If OpenSesame received the artifact it would, however
briefly, hold the customer's unreleased binary. That is a class of asset we do
not want, do not have a retention policy for, and would have to defend. Digests
are not the artifact and cannot be turned back into it.

**No exfiltration surface.** An endpoint that accepts arbitrary bytes and is
reachable by anyone who can sign is an upload channel. Combined with any
later read surface it becomes a way to move data through the gateway. A
64 KiB digest-shaped body closes that off by construction rather than by
size limit alone.

**Bounded request size and cost.** Real signing inputs are gigabytes
(container images, installers, OS packages). Streaming them to a central service
would make signing latency a function of artifact size and network, and would
put the gateway in the data path of every release. Digest-only makes a signature
a constant-cost operation regardless of what is being signed.

The consequence, stated honestly: OpenSesame signs a digest it did not compute.
It cannot know what bytes that digest covers. That is what the scope pinning in
§3 exists to constrain — not to establish what was signed, which is
unknowable from a digest, but to establish that *this* digest was authorized in
*these* circumstances, so an unexpected signature is attributable and a
pre-approved one cannot be reused for a different input.

The standard tools already work this way: `jarsigner`, `cosign`,
`osslsigncode`, `apksigner` and `gpg` all hash locally and hand the digest to a
PKCS#11 token. Digest-only intake is what makes the provider module in §5
possible at all.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 3. Scoped approvals: pinning fields, and what each is worth

A signing approval request carries a `scope_json` — any subset of these fields —
and a sign is permitted only if **every present field matches**:

| Field | Pinned to | Trustworthiness |
|---|---|---|
| `command` | the invoking command line, whitespace-tolerant | client-asserted |
| `application_name` | the signing tool's executable name | client-asserted |
| `application_sha256` | SHA-256 of that executable | client-asserted |
| `hostname` | the requesting machine's hostname | client-asserted |
| `os_username` | the OS user running the tool | client-asserted |
| `ip` | **server-observed** source address | server-observed |
| `data_hash` | the exact digest to be signed | client-asserted, but binding |

Absent fields are unconstrained, so an approval is as tight as the requester and
approver choose to make it. Present fields are compared exactly (the command
comparison normalizes whitespace runs, because shells and CI systems reformat
argument spacing without changing meaning).

**Honesty about what these prove.** Every field except `ip` is asserted by the
client. A fully compromised signing host can lie about all of them. They are not
authentication; the machine identity or session is. What they are is a
*binding between an approval and a circumstance*, and that has two real effects:
an approval granted for "cosign, from build-host-3, over digest X" cannot be
silently reused for a different digest from a different host, and any mismatch
produces a denied `signing_events` row that names exactly which pin failed — a
high-signal detection, since legitimate use rarely trips one.

`data_hash` is the strongest of them in practice: it is the field that turns a
pre-approval from "you may sign" into "you may sign this", which is the
difference between a standing capability and a one-shot authorization.

**`ip` is server-observed and therefore trustworthy — conditionally.** The
gateway records the peer address of the connection, not a header. When the
gateway sits behind a reverse proxy or load balancer, the peer address is the
proxy's, and the real client address arrives in a forwarded header that anyone
who can reach the gateway can forge. So: the forwarded header is honored **only
when a trusted-proxy configuration is set**, naming the proxy addresses whose
forwarded headers are believed; absent that configuration the peer address is
used and forwarded headers are ignored entirely. An `ip` pin is worth exactly
what the deployment's trusted-proxy configuration is worth, and the validation
doc says so. This is not a subtlety we can push onto operators silently —
misconfigured, it turns the one server-observed pin into another
client-asserted one.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 4. Approved requests become immutable access records with counters and windows

An approved signing request materializes a `signing_access_records` row. The
record is **immutable** — its `scope_json`, its signature cap, and its window
are fixed at approval and cannot be edited afterwards. Amending an approval
means requesting a new one. An editable approval is one where the thing approved
is not the thing used.

Two independent limits, either or both:

- **`signatures_allowed`** — a cap; `signatures_used` increments per successful
  signature. `NULL` means unlimited within the window.
- **`window_expires_at`** — 1h / 8h / 24h / 7d / 30d / none.

The counter increment is part of the same transaction as the signature's
`signing_events` append and the record read, taken under the row's optimistic
`version`. Doing this atomically is not a nicety: a naive read-check-sign-write
lets N concurrent requests all observe `used = cap - 1` and all proceed,
which is exactly the race an attacker with a valid access record would drive to
turn a one-signature approval into many. A losing writer re-reads and either
proceeds within the remaining budget or is denied — never silently over-spends.

Other lifecycle rules: multi-step, M-of-N-per-step approval policies via the
shared approval engine (the signing variant of the issuance engine); **self-
approval is forbidden** by default, so the requester cannot be one of the
required approvers; an operator may "request to sign" with a justification and
an administrator may "pre-approve" a scope in advance; and any administrator may
revoke a live access record, which takes effect on the next sign attempt.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 5. A PKCS#11 provider module, and a build-only Windows KSP

**`crates/pkcs11-provider`** (forthcoming) is a `cdylib` exposing the
sign-only subset of PKCS#11 v2.40 — `C_Initialize`, `C_OpenSession`, `C_Login`,
`C_FindObjects*`, `C_SignInit`, `C_Sign`, and the object-attribute calls those
require — and proxies each signature to the Sign API over the local daemon
socket using machine-identity authentication. The token label is the signer
name, so `jarsigner`, `cosign`, `osslsigncode`, `apksigner` and `gpg` address a
signer by the name an operator already knows.

A provider module is the right shape because it is the shape the tools already
speak. The alternative — a wrapper CLI per tool — would mean reimplementing each
tool's invocation surface and would break whenever one changed. PKCS#11 is
unlovely, but it is the interface every signing tool has agreed on, and
implementing only the sign-only subset keeps the surface small: the module has
no key generation, no key import, no key extraction, and `C_GetAttributeValue`
never returns a `CKA_VALUE` for a private key, because there is none to return.

**`crates/windows-ksp`** (forthcoming) is a CNG Key Storage Provider stub for
`signtool`, and it is **build-only**. It is cross-compiled for
`x86_64-pc-windows-gnu` in the done-command and is not executed anywhere in CI,
because CI runs on Linux and a CNG provider cannot be loaded without a Windows
CryptoAPI host. If the Windows target toolchain is unavailable in a given CI
environment, the gate degrades further to a `#[cfg(target_os = "windows")]`
compile guard.

This limitation is recorded rather than papered over. "It compiles for Windows"
is a real but weak claim, and `docs/validation/certificate-manager.md` states it
in exactly those terms. A KSP that has never been loaded by `signtool` on a real
Windows host is unvalidated for its actual purpose; operator acceptance testing
is the validation obligation.

Gate: `cargo +1.88.0 build -p opensesame-pkcs11-provider`

### 6. A per-signer activity ledger, with credential arguments redacted

Every signing attempt — succeeded, failed, or **denied** — appends a
`signing_events` row: signer, access record, outcome, and the observed context
(`command`, `application_name`, `application_sha256`, `hostname`, `os_username`,
`ip`, `data_hash`, `occurred_at`). Denied attempts are recorded because a denial
is the interesting event: it is the signal that someone tried to sign outside an
approved scope, and dropping it would discard the only detection the pinning
model produces.

The ledger is read through `GET /api/v1/certmgr/signers/{id}/activity`, visible
to signer `auditor` and above. It is separate from the outbox audit events of
ADR 0066 §5, which continue to fire, because signing activity is queried per
signer at a different rate and granularity than certificate lifecycle events.

**Command lines are redacted before they are written.** A recorded command line
routinely contains credentials — `--password X`, `--token X`, `-storepass X`,
`--key-password X`, a bearer in a URL. Storing them verbatim would make the
activity ledger a credential store, readable by every signer auditor, and would
convert a low-sensitivity audit read into a secret disclosure. Redaction happens
at write time, not at read time, so the credential never lands in the database in
the first place: a read-time filter leaves the plaintext at rest, one query away.
The redaction covers a maintained argument-name denylist plus value-shape
heuristics, and it is deliberately over-eager — a redacted argument that was
harmless costs an auditor nothing, and a missed one is a leak.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 7. Signing is human ceremony on every agent surface

`certmgr.signer.sign` and every signing-approval capability are excluded from
`webmcp` and from MCP act tools, citing this ADR and ADR 0065. Read capabilities
(signer list, activity, access-record list) map to MCP read tools behind Zod
projections that emit no key material and no unredacted command lines.

An agent that can sign is an agent that can ship software over the
organization's signature. Whatever the merits elsewhere of agent-initiated
actions, this is the operation where a human must be the one who decides.
`assertsNoSecretTools` (`apps/mcp-host/src/tools.ts`) and the registry parity
suites enforce it mechanically.

Gate: `pnpm --filter @opensesame/capability-registry test`

## Alternatives considered

- **Accept artifacts and hash server-side.** Would let OpenSesame attest to what
  it signed. Rejected on custody (§2): holding customers' unreleased binaries is
  a liability with no offsetting benefit, and every standard signing tool
  already hashes locally.
- **Ambient signer authorization — membership is enough.** Simplest, and how a
  keychain-held signing key works today. Rejected: it makes every signature by
  an authorized principal indistinguishable from every other, which is precisely
  the property that made historical code-signing compromises so durable.
- **Server-side policy on artifact *content* rather than digest pins.** Requires
  §2's artifact intake and a parser per artifact format — a large attack surface
  parsing untrusted binaries — to gain a check the digest pin already
  approximates.
- **Wrapper CLIs per signing tool instead of a PKCS#11 module.** Rejected in §5:
  N integrations that break independently, versus one interface the tools
  already implement.
