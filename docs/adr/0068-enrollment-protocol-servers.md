# ADR 0068 — Enrollment protocol servers, and the narrow ACME directory supersession

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0017 (host/client topology), ADR 0032 §3 (catalog is data),
ADR 0066 (Certificate Manager domain model), ADR 0067 (revocation)
Supersedes in part:
[ADR 0052 — automatic certificate authority selection](0052-automatic-certificate-authority-selection.md)
§ "ACME profile", **only** its refusal of arbitrary ACME directory URLs, and
only under the constraints of §5 below. Its refusals of upstream HTTP-01 and
TLS-ALPN-01 are restated and **kept** (§6).
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

Today OpenSesame is only an ACME *client*: `apps/gateway/src/cert_issuers/acme.rs`
drives `instant-acme` against a code-pinned registry of public directories
(`apps/gateway/src/cert_issuers/registry.rs`), and the only way to get a
certificate out of OpenSesame is to ask its own API for one. Everything that
already speaks a standard enrollment protocol — Certbot, cert-manager, win-acme,
an EST-capable router, a SCEP-enrolling MDM fleet — has no way in.

That is the single largest adoption barrier in the certificate surface. Devices
and platforms do not adopt a new API; they adopt a CA they can point their
existing enrollment client at. ADR 0066 gave us the profile object those clients
need to be scoped to. This ADR decides which protocols OpenSesame terminates,
and — separately — revisits what OpenSesame will speak *as a client*.

Those two directions get confused easily, and the confusion is the reason
ADR 0052-cert's HTTP-01 refusal keeps being read as a general position on
HTTP-01. It is not. §6 and §7 pull them apart explicitly.

## Decision

### 1. OpenSesame terminates ACME (RFC 8555) per profile

`/acme/{profileId}/*` (forthcoming `apps/gateway/src/routes/acme_server.rs`)
implements an RFC 8555 server: `directory`, `new-nonce`, `new-account`,
`new-order`, `authz/{authzId}`, `challenge/{challengeId}`, `finalize/{orderId}`,
`cert/{certId}`, `revoke-cert`.

The scoping unit is the **profile**, not the organization: the directory URL a
client is configured with determines which CA signs, which policy constrains,
and which defaults apply. That gives an operator a single string to hand to
Certbot or a cert-manager `ClusterIssuer` and no further configuration.

Protocol mechanics that are load-bearing rather than incidental:

- **Nonces are single-use.** Every `new-nonce` mints a row in the forthcoming
  `acme_nonces` table; every JWS-authenticated POST consumes one, and a replayed
  nonce is rejected. This is the protocol's only anti-replay mechanism and the
  cheapest place to get it wrong.
- **JWS verification is ours to do correctly.** Account key thumbprints are
  stored and every request's signature is verified against the bound account
  key. Order and authorization objects are looked up by id *and* checked to
  belong to the requesting account, so an attacker with a valid account cannot
  finalize someone else's order.
- **Finalize validates the CSR against the profile's policy** before issuing
  (ADR 0066 §2). A client can ask for anything; the policy decides what it gets,
  and a policy-violating CSR is a `badCSR` problem document, not a narrowed
  certificate.
- **`revoke-cert` routes into ADR 0067's revocation record**, so an
  ACME-initiated revocation appears in the CRL and OCSP like any other.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 2. External Account Binding is required on every profile

`new-account` requires EAB (RFC 8555 §7.3.4). The HMAC key and key id come from
the profile's enrollment config (ADR 0066 §1), sealed under the `eab_secret`
scope.

Requiring it is not configurable. An ACME directory without EAB accepts an
account from anyone who can reach it, and this directory is backed by an
internal CA whose certificates a fleet trusts. EAB is what makes "reachable" and
"authorized to enroll" different questions. Public ACME CAs can skip EAB because
they still require domain validation against the public DNS; an internal CA
issuing for internal names has no such external check, so the account-creation
gate is the check.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 3. HTTP-01 validation, plus an admin-enabled skip-validation mode

A profile's ACME enrollment config selects `challenge: "http-01"` or
`challenge: "skip"`.

`http-01` performs the standard validation: fetch
`http://<identifier>/.well-known/acme-challenge/<token>` and compare the key
authorization. This is one of exactly two sanctioned raw-egress paths in the
gateway (the other is the discovery scanner); it bypasses
`ConnectionBroker::authorized_json` because there is no connection and no
credential involved — it is an unauthenticated GET to a name the order already
names. It is constrained to the order's own identifiers, uses plain HTTP by
protocol requirement, follows no redirects to a different identifier, is
size-capped, and is time-bounded. Those constraints, not the broker, are what
fence it.

`skip` issues without proving control of the identifier. It exists because the
dominant internal use is names that resolve only inside a private network, that
no public validator can reach, and that no external party could claim anyway.
It is **admin-enabled per profile**, never a default, never a fallback when
HTTP-01 fails, and recorded in the issuance audit event so a certificate issued
without validation is identifiable after the fact. A profile in skip mode is
only as safe as its EAB secret and its policy constraints — which is why §2
makes EAB non-optional and why skip-mode profiles should carry tight
name constraints.

DNS-01 is not offered on the server side. Serving a DNS-01 challenge would
require the enrolling client to mutate DNS we do not control, which gains
nothing over HTTP-01 for internal names and nothing over `skip` for names that
resolve nowhere public.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 4. EST (RFC 7030) and SCEP (RFC 8894), also profile-scoped

**EST** at `/.well-known/est/{profileId}/*` (forthcoming
`apps/gateway/src/routes/est_server.rs`):

- `GET /cacerts` returns the profile CA's chain as a PKCS#7.
- `POST /simpleenroll` and `POST /simplereenroll` take a PKCS#10 CSR and return
  a PKCS#7. Authentication is either an EST passphrase (sealed under
  `est_passphrase`) or a bootstrap client certificate validated against an
  operator-uploaded CA chain; re-enrollment additionally supports mTLS with the
  certificate being replaced.

**SCEP** at `/scep/{profileId}/pkiclient.exe` (forthcoming
`apps/gateway/src/routes/scep_server.rs`, CMS codec in the forthcoming
`crates/scep`):

- `GetCACaps`, `GetCACert` (RA certificate and chain as PKCS#7), and
  `PKIOperation` (`PKCSReq` / `RenewalReq` / `GetCertInitial`) with CMS-wrapped
  requests, AES-256/128-CBC and SHA-256/384/512.
- Two challenge modes. **Static**: a shared secret of at least 8 characters,
  stored hashed and sealed (`scep_static_secret`), compared in constant time.
  **Dynamic**: one-time challenges minted at an authenticated
  `POST /scep/{profileId}/challenge`, with a bounded expiry (≤ 1440 minutes) and
  a bounded pending set (≤ 1000), consumed exactly once.

Dynamic challenges are the mode to prefer and the reason both exist. A static
SCEP secret is shared across a fleet, is often embedded in an MDM payload, and
cannot be rotated without touching every device. A one-time challenge is minted
per enrollment by something that already authenticated. Static mode is retained
because a great deal of real hardware only speaks it. The dynamic mint endpoint
is also the seam an Intune challenge adapter would attach to
(ADR 0066 §N3).

SCEP's protocol-level cryptography is old — CMS with RSA key transport, and a
challenge-password field that is a shared secret in a signed envelope. We
implement it faithfully rather than inventing a hardened variant, because a
non-conformant SCEP server is worse than none: the devices that need SCEP cannot
be changed, and a bespoke deviation just moves the failure from "insecure by
protocol design" to "insecure and incompatible". The mitigations available to us
are the ones we take: dynamic challenges, per-profile scoping, policy
constraints on what a `PKCSReq` can obtain, and short TTLs.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 5. Supersession: private ACME directories may be registered by admins

**The exact supersession language.**

> ADR 0052-cert's "ACME profile" section refuses "HTTP-01, TLS-ALPN-01,
> arbitrary ACME directory URLs, and automatic certificate deployment … as
> unsupported rather than partially implemented." This ADR supersedes exactly
> one clause of that sentence — **arbitrary ACME directory URLs** — and only in
> the following narrow form: an **organization administrator** may register a
> **private ACME directory** (step-ca, HashiCorp Vault's ACME endpoint, an
> internal Boulder, or another operator-run CA) as an external CA connector.
> Every such directory is assigned the trust class `private_local` in
> OpenSesame code, never a class supplied by the registrant. The `public_web`
> trust class remains pinned to the code-owned registry in
> `apps/gateway/src/cert_issuers/registry.rs` and is unreachable from
> configuration. ADR 0052-cert's refusals of upstream HTTP-01 and TLS-ALPN-01
> are **not** superseded; they are restated and kept in §6. Its refusal of
> automatic certificate deployment is superseded separately and on its own
> terms by ADR 0069.

The reasoning. ADR 0052-cert's refusal was aimed at a real hazard: if a caller
can name a directory URL, a caller can point issuance at a CA of their choosing
and receive back a certificate labelled as if OpenSesame had vetted its trust.
The refusal protected the *trust class*, and it protected it by refusing the
whole feature because there was no other mechanism at the time.

There is one now. `TrustClass` is assigned in code from `IssuerKind`
(`apps/gateway/src/cert_issuers/model.rs`), and ADR 0065's connector rules
already state that "trust semantics are platform-owned … a community connector
may propose an issuer row; trust classification is assigned in platform code
review." A registered private directory therefore cannot claim to be
`public_web`; it is `private_local`, exactly like OpenSesame's own CA, meaning
relying parties must install its root explicitly. The hazard the original
refusal addressed is closed by construction rather than by absence.

The remaining constraints, all of which are conditions of the supersession:

- Registration is **admin-only** (`Caller::can_configure_integrations`), stored
  as an `external_ca_configs` row with `kind = 'private_acme'`.
- The directory is reached through a broker connection, so its egress allowlist
  applies and pinned TLS is enforced. It is not a bare URL the issuance path
  dereferences.
- `trust_class` is written by code from the connector kind; the registration
  payload has no trust field. A request to issue with a caller-chosen trust
  class is rejected as an unknown field (`deny_unknown_fields`).
- Optional EAB credentials are sealed under `eab_secret`.
- Failure never falls back to another issuer — ADR 0052-cert's no-downgrade rule
  applies unchanged.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 6. Upstream HTTP-01 stays refused

As an ACME **client**, OpenSesame continues to support DNS-01 only. ADR
0052-cert's rationale is restated because it is still the whole argument:

- **DNS-01 is a strict superset of what HTTP-01 can prove.** It is the only
  challenge that can obtain wildcard certificates. HTTP-01 cannot, ever.
- **HTTP-01 requires inbound port 80** on the host named in the certificate,
  reachable from the CA's validators. That is a firewall and topology
  requirement we would be imposing on the user's infrastructure in exchange for
  a capability DNS-01 already provides.
- **HTTP-01 requires the requesting host to be the serving host.** OpenSesame is
  a gateway requesting certificates on behalf of services that run elsewhere;
  it has no way to place a token on a machine it does not run on. DNS-01 needs
  only a scoped DNS connection, which the broker already fences
  (`BrokeredDns01` in `apps/gateway/src/cert_issuers/registry.rs`).

This is also not a competitive loss: the compared product is likewise DNS-01-only
on its upstream client path. We are declining a capability nobody in this
comparison offers, for reasons that would hold regardless.

TLS-ALPN-01 stays refused for the same shape of reason, more strongly: it
requires control of the TLS handshake on port 443 of the named host, which a
gateway issuing on behalf of other services categorically does not have.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 7. Why terminating HTTP-01 as a server is consistent with refusing it as a client

These look contradictory and are not. The trust direction is opposite.

**As a client**, OpenSesame is the party being validated. Accepting HTTP-01
would mean accepting an obligation — serve a token from port 80 of a host named
in the certificate — that OpenSesame frequently cannot discharge, in exchange
for less capability than the mechanism it already has. The refusal is about
what we can honestly promise.

**As a server**, OpenSesame is the party doing the validating. HTTP-01 is a
check we run against a claimant, inside a profile an administrator configured,
behind a mandatory EAB gate, over an internal CA whose root only that
administrator's fleet trusts. If the check is weak, the party it under-protects
is the operator who chose the profile, who can also choose `skip` and knows what
that means. The failure mode of a weak server-side challenge is bounded by the
profile's policy and its EAB secret; the failure mode of a client-side challenge
we cannot complete is issuance that simply does not work.

Put differently: refusing HTTP-01 as a client is a statement about our own
topology. Offering it as a server is a statement about what an operator may
require of their own devices. Nothing about the first constrains the second.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 8. Enrollment endpoints carry no session and are contract-allowlisted

None of `/acme/*`, `/.well-known/est/*`, `/scep/*` use `resolve_caller`. Each
authenticates with its own protocol's mechanism — JWS + EAB, EST passphrase or
bootstrap certificate, SCEP challenge — and each is scoped to exactly one
profile by its path. They carry explicit `DefaultBodyLimit`s, `deny_unknown_fields`
on every parsed body, and are listed in `apps/gateway/src/routes/contract.rs`'s
allowlist with a protocol-endpoint category comment, so a reviewer sees that the
session exemption is deliberate. Each is also excluded from every agent surface:
an enrollment endpoint is spoken by a protocol client, not by an agent.

Gate: `pnpm --filter @opensesame/capability-registry test`

## Consequences

- Certbot, cert-manager, win-acme, EST-capable network gear and SCEP-enrolling
  MDM fleets can enroll against OpenSesame without any OpenSesame-specific
  client. This is the adoption unlock; everything else in this ADR is the cost
  of it.
- The gateway now implements server halves of three protocols, including their
  cryptography (JWS verification, CMS). This is the largest correctness surface
  in the certificate work and the one where a bug is a trust bug. It is
  validated hermetically — the ACME server against the in-tree `instant-acme`
  client, EST and SCEP against recorded fixture requests — and the ACME JWS and
  SCEP CMS parsers get fuzz targets in `fuzz/Cargo.toml`.
- Skip-validation profiles are a foot-gun by construction. They are audited,
  admin-gated, per-profile, and named honestly rather than hidden behind a
  friendlier word.
- The private-ACME supersession means an organization can now route issuance to
  a CA OpenSesame did not vet. It is contained by trust class, so the worst
  outcome is a certificate correctly labelled `private_local` from a CA the
  administrator chose — which is the same trust posture as OpenSesame's own
  private CA.
- Upstream HTTP-01 and TLS-ALPN-01 remain refused. A user who needs them needs a
  different tool for that hop; wildcards and DNS-01 cover the cases we have.
