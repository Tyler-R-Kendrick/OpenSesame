# ADR 0094: Browser authority requires pairing and purpose-bound proof

Status: accepted

## Context

A public application origin, loopback transport and a local user account are not
authorization boundaries. A path under a shared web origin does not isolate
scripts or storage. Native operator authority must not cross into browser code.

## Decision

The Host admits browser pairing only from explicitly configured exact eligible
origins. It no longer force-adds the author's Pages origin. Pairing creates a
short-lived request bound to the origin, Host audience and DPoP public-key
thumbprint. A native operator inspects the request and selects the canonical
principal and organization before approving it. The browser receives a
five-minute DPoP credential, never the operator credential. The device secret
travels in a request body, not a URL.

Initial grants permit only owner-scoped encrypted sync read/write. This local
approval proves neither federated identity nor phishing-resistant verification.
Typed session claims report that lower assurance honestly. The initial grant
cannot administer integrations, secret configurations or browser control.

Browser requests use `Authorization: DPoP` with a proof binding the token,
method, canonical URL, key, time and replay identifier. Host middleware applies
an explicit route/capability map before dispatch. Browser credentials presented
as Bearer are refused. Revocation removes grants and pending authorizations.
CORS is credentialless and route-specific; its header allowlist excludes the
operator header. Private-network admission is limited to eligible pairing and
active paired route groups and does not replace proof validation.

An Identity authorization is a distinct signed, purpose-bound assertion. Host
verification pins issuer and public keys in operator configuration; assertion
metadata cannot select a key endpoint. Browser authentication and control each
require a challenge bound to the client, principal, organization, origin, key,
audience and exact operation. Control additionally binds the run version and
transition. Recent WebAuthn evidence is required, with a maximum five-minute
window. Durable replay claims and one-use elevation consumption prevent a
successful proof from authorizing another run or a second transition. Expired
control leases park the run; they do not restart autonomous execution.

Identity evidence does not implicitly grant Host organization administration.
Its role can only narrow the durable Host role ceiling described in
[ADR 0098](0098-secret-metadata-authorization.md).

## Deployment profiles

Pages compiles an exact canonical origin and one of `loopback_development`,
`dedicated_origin` or `shared_origin_demo`. Runtime endpoint settings cannot
promote that profile. Dedicated deployment requires HTTPS and an explicit
header-security hosting contract. A canonical-origin mismatch degrades to the
restricted demo. The known path-hosted GitHub project origin cannot be declared
dedicated.

The shared-origin demo retains offline vault use, compiled Google-via-Shoo and
every guest road. Local pairing is unavailable; no backend setup wall replaces
those roads. Production origin isolation requires actual exclusive origin
ownership and real response headers, not a path or a meta CSP alone.

## Consequences and evidence

DPoP limits off-origin token replay. A malicious script already executing at an
authorized origin can use its non-extractable key: DPoP is not an XSS cure.
Pairing is not passkey verification. Same-user malware remains a local threat.
The current browser route map is intentionally narrower than the complete Host
API; authenticated browser status is not blanket permission for all user APIs.

Enforcement lives in Host browser-grant middleware, browser-pairing and
Host-authorization routes, durable storage, and Pages deployment/profile
clients. Focused proof, replay, pairing and control tests are regression evidence;
this decision does not claim full integrated verification or production rollout.
