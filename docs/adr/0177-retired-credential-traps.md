# ADR 0177: Retired credential traps in the offline client

Status: Accepted

## Decision

Security settings expose owner-selected retired password traps. Exact matches
are scoped to the vault tomb. Enrollment, removal and clearing evidence require
fresh authentication with the current authoritative password protector and a verified manifest MAC, in an already-open real-owner session. This version supports one password protector without additional authentication steps; other configurations fail closed. A bounded expensive verifier
set is separate from ordinary encrypted password history; plaintext submitted
passwords are never evidence. Retired passwords have no authority over the real
vault. The default response records `retired_credential_observed` and rejects.
The optional response opens a fresh synthetic compartment and ephemeral guest
vault with an independent key and session identity.

This trigger is independent of human duress: no real-item snapshots, device
incident, global fence, freeze or wipe policy is activated. Real tabs remain
available. Ambiguous current-password reuse is refused. No typo or variant
matching is performed. Retention is capped at three traps and 32 observations per vault. Verification uses Argon2id (64 MiB, three iterations, one lane), serialized under a browser lock. Enrollment and password commits share that lock. Decoy writes are limited to 100 items and 256 KiB of serialized body data.

The decoy session's keys and body belong to a separate scratch guest realm,
preserving existing guest files and connection references. Follow-on local
evidence records only closed action types for synthetic writes and denied
authority requests; it contains no submitted secrets or arbitrary activity text.
A tab-local marker
adds deny ceilings at Identity and Host transports, browser pairing, connector
creation and consent, federation, project changes, real vault unlock and export,
and WebMCP dispatch. It is never a privilege grant: removing the marker cannot
make a guest key decrypt a member vault. Returning requires locking the decoy
and creating a new session through real authentication. Existing ambient cookies
and grants remain unavailable through these transports after the decoy locks,
until fresh authentication to the original owner vault completes. A sealed
tab-local pending context survives normal page reloads; it binds both the tomb
and vault identity and does not fence other tabs. Cached session, grant and
connector getters also suppress production authority during this interval.
Only successful real-root admission after all required factors clears the
context. Creating a guest, a new vault or an unrelated owner vault cannot clear it.

Connected email/SMS second steps use a private, short-lived permit issued only
after fresh primary-root proof. The adapter accepts fixed POST send/verify
routes, bounded payloads and the same realm and challenge binding; ordinary
Identity transport remains denied until final owner admission.
Operator consent for a duress snapshot does not authorize disclosure to a
retired password holder.

## PWA trust limits

This is local presentation and local evidence, not a hosted authentication
service or cryptographic honey encryption. An attacker modifying JavaScript,
service workers or device storage can bypass deception and reporting. Recognition
of a retired password establishes possession, not malicious intent or a new
breach. Offline guesses against authenticated ciphertext remain possible.
An old snapshot that recovers a reused vault key still exposes ciphertext under
that key; password rewrapping and decoys do not replace compromised-key rotation.

A separately stored password-only verifier creates an offline guessing target,
including in a two-secret design that otherwise withholds a guessing oracle.
Enrollment requires acknowledgment. A browser-local pepper would not create an
independent security boundary. Only selected traps are retained, not automatic
password history. Owners must lock a mistaken decoy before saving real secrets.

## Canaries and agents

Synthetic data contains no working third-party credentials. A fake vendor key
has no observation path by itself. The shared canary engine mints independent
32-byte random identifiers and retains domain-separated digests bound to the
vault identity, artifact kind and generation. These inexpensive digests are for
issuer-generated identifiers only, never passwords. Retention is bounded to 16
artifacts, 64 observations and 32 KiB per vault. Artifact dispatch, connection,
tool invocation and retired-generation replay are distinct closed events.

An exported MCP canary has a separately installed, metadata-only validator.
Its stdio handler exposes only a fixed synthetic status tool. Installation in
another CLI environment imports the digest binding, not a real vault header,
root, session or connector. Browser and CLI storage are independent: revoking
the browser artifact does not silently uninstall that detector. Its owner must
explicitly uninstall it in the validator environment. Evidence there is local
to that environment unless a delivery path is separately configured.

Retirement enrollment accepts an opaque reference resolved by the actual issuer,
not a caller-supplied assertion that an arbitrary token was valid. Runtime lease
aliases refer to the same original activation lease and keep its approval,
generation, identity and cancellation checks. Runtime-only issuer inventory does
not survive reload. The Host's organization-scoped ledger provides durable
aliases to already authorized connections; an alias never grants an additional
operation, resource or destination. Expiry and retirement refuse production
execution. Reserved malformed or unknown identifiers cannot fall through into
ordinary connector resolution. Deception never replaces broker authorization.

## Optional independent observations

Local evidence remains available without a receiver. External delivery is an
explicit real-owner setting with independently provisioned key material and a
fixed destination. A new binding is disabled until a real test receives an
authenticated acknowledgement. It is not an email/SMS contact subscription or
a production connector, and no external receiver is silently provisioned.

The sender accepts a fixed HTTPS origin, or an explicitly approved strict HTTP
loopback origin, and posts only to `/v1/credential-observations`. Cookies,
authorization headers and redirects are excluded. Closed metadata is sealed
with independent AES-GCM and authenticated with an independent HMAC; the real
vault root is never delivery material. Acknowledgements bind the package,
receiver binding and key epoch. A successful HTTP status alone is insufficient.
The shared protocol and independent conformance vector live under
`packages/app-core/src/lib/credential-observation/`.

The device-sealed outbox is independent of real-vault unlocking. It is capped
at 32 entries, 64 KiB, five attempts per package and a 24-hour lifetime. A
persisted hourly budget limits new packages to eight per vault/receiver, with
one-minute duplicate suppression. Clearing canary evidence does not reset the
delivery budget. Dispatch releases owner and credential locks before waiting
for a response. Disable, removal and replacement discard unsent packages and
invalidate late acknowledgements; they cannot retract a previously dispatched
request. Unavailable delivery cannot restore retired authority, open the real
vault, or invoke a duress fence. Browser storage loss or tampering can still
prevent local delivery.

Attacker-controlled activity and logs are untrusted data and must not become
instructions to an incident agent with real-vault access. External actions and unbounded computation are excluded. Decoy body writes
are capped at 100 items and 256 KiB of serialized body data, including inline
file payloads; rejected mutations restore the prior body. Success means no real data or
authority escapes even after an attacker recognizes the decoy. Enrollment and
evidence-management capabilities are human-only, excluded from CLI agent, MCP
and WebMCP surfaces.

## Validation

Exercise stale legitimate passwords, current-password collisions, bounded work,
restored storage, existing member tabs, direct transport calls, connector consent,
project switching, exports and fresh reauthentication. Compare with the default
record-and-reject response; engagement time alone is not a security measure.

## Native implementations

The shared Rust human-vault engine uses the same public ASCII and distinct
composed/decomposed UTF-8 Argon2id vectors as the TypeScript classifier. Fixed
parameters cannot be selected by stored records. A process-local KDF work lock
limits concurrent derivation memory; native disk reads are capped before parsing.

Native sealed-store management authenticates the current owner against its
versioned root manifest under the existing key-file edit lock. Traps are scoped
to the manifest's vault identity and retain no root. Password changes and root
rotation refuse reuse of an enrolled retired credential under that same lock.
The production `unlock_store_key` path rejects every retired match. Native
read admission is a sum type: a real `ItemDataKey`, or a synthetic-only realm
that cannot yield that key. Ordinary CLI show/list/find consume this type; no
production root or connector is passed to a synthetic branch. Management is a
human-terminal ceremony, not an agent operation. A CLI command is one invocation,
not a persistent PWA tab session, so fresh real admission occurs on the next
command. Existing native filename metadata and stolen snapshots remain outside
the deception guarantee.
