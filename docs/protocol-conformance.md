# Protocol conformance (identity plane)

Mandatory local suite does **not** require cloud IdP credentials.

| Feature | Spec | Library | OpenSesame-owned |
|---------|------|---------|------------------|
| OIDC discovery / JWKS | OIDC Core, RFC 8414 | oidc-provider | Mount + issuer config |
| Auth code + PKCE S256 | RFC 7636 | oidc-provider | Public-client policy |
| Device authorization | RFC 8628 | oidc-provider | Domain projection + console UX |
| PAR | RFC 9126 | oidc-provider | Feature enabled |
| Resource indicators | RFC 8707 | oidc-provider | Client allowlists |
| DPoP | RFC 9449 | oidc-provider | CLI/agent preference |
| Revocation / introspection | RFC 7009 / 7662 | oidc-provider | Policy gates for introspect |
| Pairwise `sub` | OIDC Core | oidc-provider + store | Sector mapping table |
| Protected resource metadata | RFC 9728 | Hono | `/.well-known/oauth-protected-resource` |
| Passkeys / anonymous | WebAuthn L3 | Better Auth | Principal mapping adapter |
| Origin client profile | OpenSesame (not IETF) | OpenSesame | Feature flag + restrictions |
| CIMD | Draft | oidc-provider (gated) | SSRF fetcher; **disabled by default** |
| DCR | RFC 7591 | oidc-provider (gated) | **Disabled by default** |
| auth.md / Agent Card | Product profile | agent-protocols | Generated from config |
| OID4VP holder | OpenID4VP 1.0 + HAIP 1.0 | Multipaz 0.100.0 (native) | Vault selection, consent, verified invocation |
| OID4VCI wallet | OpenID4VCI 1.0 + HAIP 1.0 | Multipaz 0.100.0 (native) | Issuer policy, encrypted custody, verified invocation |

## Draft features (pinned / gated)

| Flag | Default | Fallback |
|------|---------|----------|
| `OPENSESAME_ORIGIN_CLIENTS_ENABLED` | false | Pre-registered clients only |
| `OPENSESAME_CIMD_ENABLED` | false | Reject URL client_ids |
| `OPENSESAME_DCR_ENABLED` | false | `/reg` denied |
| ATProto / Nostr adapters | disabled | Interfaces only until mandatory green |

Do **not** claim OAuth 2.1 RFC compliance; follow RFC 9700 BCP.

## Authenticator and wallet implementation status

OID4VP and OID4VCI are product requirements, not excluded protocols. The
repository implements their trust-domain records, strict by-reference native
invocation, encrypted SD-JWT VC/mdoc custody types, user-verification policy,
and the website association artifacts needed to hand a request to the signed
native app. ADR 0058 fixes Multipaz as the native protocol engine so request
objects, DCQL, issuer metadata, proofs, presentations, and response modes are
not reimplemented ad hoc.

The feature flags remain deployment gates until the signed native builds pass
the OpenID Foundation conformance profiles. A false flag means "not enabled in
this deployment"; it does not mean the product excludes OID4VP or OID4VCI.
No certification or hardware-backed-key claim may be made from repository
unit tests alone.

FedCM, OpenID Federation, and Token Status List adapters remain separate work;
they are not prerequisites for implementing the OID4VP/OID4VCI wallet roles.

The implemented invariant surface is covered by
`packages/trust-broker/src/index.test.ts`: evidence expiry, subject-kind
separation, and the non-equivalence of MFA and phishing resistance.
