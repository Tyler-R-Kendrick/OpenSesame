# Host authority binding and lifecycle review

Date: 2026-09-08. Scope: the integrated hardening branch's Host browser
authentication, startup configuration, Identity evidence, control transactions
and observation streams. This public record describes invariants and regression
anchors, not private attack instructions or production credentials.

## Implemented boundaries

Browser pairing is explicit and origin-bound. A native operator decision selects
the principal and organization; the resulting browser grant is not an operator
credential. Initial pairing permits only its bounded ciphertext-sync ceiling and
reports local, unverified assurance. A paired browser does not infer ownership or
MFA from loopback reachability or a pairing click.

Host browser requests use `Authorization: DPoP` and a proof bound to the presented
token, method, canonical target and public-key thumbprint. The shared proof
validator checks proof freshness and replay. The Gateway checks the durable grant,
exact origin, audience, expiry and route ceiling on each request. Native sessions,
browser grants and agent capabilities are distinct credential kinds; relabeling a
credential cannot select a weaker authenticator.

Browser CORS is route-specific, exact-origin and credentialless. Its admitted
headers exclude the operator header. Local-network preflight permission is limited
to eligible pairing/paired routes and never substitutes for actual authorization.
Public/shared-origin Pages deployments cannot promote themselves into a dedicated
origin through runtime endpoint settings. Host and daemon defaults do not force
trust in an author's public Pages origin.

Deployment-mode parsing rejects unknown, differently cased, empty and conflicting
values. Explicitly opted-in local defaults require local exposure; networked
exposure requires production-strength safeguards regardless of the mode label.
Gateway secret validation runs before durable-state construction or listener
binding. Runtime operator credentials and claim peppers have no universal
development fallback. Typed session claims require a canonical principal,
organization, role, audience, capability ceiling and lifetime, and projections
carry the stored assurance rather than synthesizing MFA. Token responses do not
duplicate bearer material in generic session metadata.

## Verified user authority and one-use control

Identity authorizes a frozen Host challenge using its real, user-verifying
WebAuthn verifier, including in development mode. Principal, purpose and
transaction digest bind the ceremony; a durable claim selects one consumer.
Identity rechecks organization membership and signs a short-lived, explicitly
typed assertion for an operator-configured Host audience. The Host verifies
operator-pinned public keys and exact challenge, principal, organization, origin,
DPoP key, target and operation binding. It does not fetch keys named by an assertion.
All temporal claims use one supplied verification instant, including `nbf`;
the JWT library's separate wall clock cannot admit a not-yet-valid assertion.

Ordinary authenticated-user routes have an explicit method-and-path capability
map. Their existing owner, organization and project policy checks remain
authoritative. That map excludes native administration, credential materialization,
private-key delivery, arbitrary proxying and browser-control transitions.

Host role policy is established by native approval and can only be narrowed by
Identity evidence. Role narrowing, its audit event, evidence replay claim and
browser authentication update commit together. A failed transaction changes none
of them. Native revocation establishes an authentication-time floor; independent
bound challenges may share a newer authentication time without reviving revoked
membership or being mistaken for replay.

Taking browser control requires recent phishing-resistant authentication plus a
one-use authorization for the exact run, transition and run version. Consumption
and the control-state write share a transaction. A stale version or failed write
does not partially consume authority. Control lease expiry is bounded by both the
credential lifetime and the verified authentication freshness window; expiration
does not silently restart agent autonomy.

## Observation lifetime

An open SSE connection is not permanent authorization. Before another poll or
buffered ciphertext event is emitted, the stream rechecks the durable browser
grant, original credential lifetime, exact principal/client/origin/key binding,
verified authentication, current observation capability, live Host membership and
revocation floor, and current run ownership. Native streams recheck their live
typed session. Failure closes the stream. It retains a server-side digest and
claims, not bearer headers or a reusable proof; the initial DPoP proof is not
revalidated as though it were a new request.

Bytes already emitted cannot be recalled. A revocation racing after an individual
authorization read can affect that in-flight bounded event; subsequent iterations
recheck authority, including events already buffered by the server. Ciphertext
courier behavior does not become permission to inspect plaintext.

## Evidence at this checkpoint

The integration steward reported these focused results on the current integrated
tree; they are not substitutes for final clean-tree verification:

- Host RSA evidence verifier: 1 focused test passed with a fixed-clock rejection matrix.
- Agent-control regression selection: 16 tests passed.
- Host authorization/membership atomicity: 4 tests passed.
- Explicit browser route-map tests: 3 standalone Rust 1.88 tests passed.
- Live SSE revalidation: all four buffered-event revocation cases passed.
- Paired metadata HTTP regression: passed with real paired DPoP requests.
- Gateway integrated selection: 603 tests passed (one pre-existing ignored test).

Regression anchors include `apps/gateway/src/host_authorization_tests.rs`,
`apps/gateway/src/routes/agent_runs_tests.rs`,
`crates/storage/tests/host_authorizations.rs`,
`apps/gateway/src/middleware/browser_user_routes.rs`,
`apps/gateway/src/middleware/browser_metadata_tests.rs`, and
`apps/gateway/src/routes/agent_run_stream_tests.rs`.

No fresh full Codex Security, DeepSec AI or Mantis campaign is claimed in this
record. No full `pnpm verify`, clean dependency scan, production deployment,
repository-governance activation or production-readiness claim follows from the
focused results above.

## Residual trust

DPoP constrains off-origin replay of copied tokens; it does not prevent malicious
JavaScript already executing at the approved origin from using its key. A
non-extractable browser key is not an XSS defense. Human verification and exact
operation binding remain necessary for elevated authority. A same-user process
is not automatically an operator; scoped local capabilities reduce its authority
but do not claim to defeat a compromised OS. Identity authentication does not
unlock an encrypted human vault. Guest and offline Pages entry remain independent
of Host and Identity availability. General interaction approvals retain their own
documented assurance contract; the Host-specific ceremony does not silently
upgrade every approval surface.
