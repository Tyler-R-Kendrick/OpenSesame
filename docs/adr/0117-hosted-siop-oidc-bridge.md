# ADR 0117 — Hosted SIOP → OIDC bridge

- Status: Accepted
- Date: 2026-09-15
- Supplements: [ADR 0116](0116-browser-native-siop-v2.md) (browser-native
  SIOPv2), [ADR 0008](0008-better-auth-oidc-provider.md) (hosted OP),
  [ADR 0011](0011-pairwise-subject-storage.md) (pairwise `sub`),
  [ADR 0033](0033-federated-identity-admission.md) /
  [ADR 0057](0057-email-linking-better-auth-and-ldap.md)
  (identity linking rules — **email join does not apply here**)

## Context

Native SIOPv2 (ADR 0116) lets a relying party verify a Self-Issued ID Token
from `sub_jwk` without involving Identity API. Some deployments also need the
**hosted** OpenID Provider to treat a verified SIOP subject as the same human
who already holds a canonical `Principal` — so conventional OIDC clients can
receive ordinary hosted tokens after an explicit cryptographic link.

That bridge is easy to misread as non-custodial: "the browser signed, therefore
the hosted OP is just a relay." It is not. Downstream clients of the hosted OP
trust the **hosted signing key**. Compromising that key still impersonates
linked subjects to those clients.

## Decision

### 1. Explicit cryptographic link only

The Identity plane records a durable link only after:

1. An authenticated principal session,
2. A server-issued challenge that freezes `nonce` and `aud` (and the expected
   SIOP issuer) on that session,
3. Successful verification of a Self-Issued ID Token via
   `@opensesame/siop-v2` `verifySelfIssuedIdToken` against that challenge,
4. Binding of `(principal_id, siop_sub, jwk_thumbprint)`.

`siop_sub` is the JWK thumbprint subject; `jwk_thumbprint` is recorded
explicitly so investigators do not have to recompute it. The link is **not**
inferred from email, display name, or any other self-asserted claim.

### 2. No email join

Verified-email secondary join (ADR 0057) does **not** apply to SIOP. A
self-asserted `email` in a Self-Issued ID Token is never a join key. Request
bodies that offer `email` / `emailNormalized` for linking are refused. SIOP
evidence attaches only through the cryptographic tuple above.

### 3. Hosted OP still signs downstream tokens

After a link exists, the hosted OP may mint ordinary OIDC tokens for the linked
`Principal` using its own signing material. Those tokens are hosted assertions.
SIOPv2 authentication evidence does not make the hosted OP non-custodial, does
not move private key custody out of the browser vault for SIOP, and does not
weaken pairwise `sub` rules for conventional clients (ADR 0011).

### 4. Surface

- `POST /v1/siop/challenges` — authenticated; stores expected `nonce`/`aud`/
  issuer on the session.
- `POST /v1/siop/link` — authenticated; accepts `id_token` + `challenge_id`,
  verifies, writes the link record, refuses email-based linking.

The link is persisted as an `external_identities` row with `kind: "siop"`,
`subject` = SIOP `sub` (JWK thumbprint), and `metadata.jwk_thumbprint`. It does
**not** go through verified-email secondary join.

Implementation: `apps/control-plane/src/services/siop-verify.ts` and
`apps/control-plane/src/routes/siop-link.ts`.

### 5. Experimental browser-signed network OIDC facade

Unchanged from ADR 0116 §5: the experimental browser-signed conventional OIDC
facade remains **unimplemented and disabled**. Vercel process-local WebSocket
routing is insufficient for durable cross-instance token signing rendezvous.
This bridge is not that facade.

## Consequences

- Operators can bind a browser SIOP key to a hosted principal without pretending
  the hosted OP is non-custodial.
- Account takeover via self-asserted email in a SIOP token is closed by
  construction.
- RPs that need pure self-issued trust verify SIOP themselves (see
  `apps/example-siop-rp`); they need not use this bridge.
