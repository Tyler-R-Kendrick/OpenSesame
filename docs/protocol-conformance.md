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
| auth.md AgentAuth (WorkOS v0.6.0, 2026-06-10) | Ecosystem profile | `@opensesame/agent-protocols` + control-plane `/agent/identity` | Anonymous + `service_auth` enabled; ID-JAG/SET disabled |
| RFC 7523 JWT bearer (AgentAuth) | Final | control-plane `/oauth2/token` | Service assertions only (`os-sia+jwt`) |
| RFC 7009 revocation (AgentAuth access tokens) | Final | control-plane `/oauth2/revoke` | Opaque `aat_` tokens; unknown tokens return 200 |
| RFC 8414 AS metadata `agent_auth` | Final + profile extension | control-plane discovery | Advertises only enabled identity types |
| RFC 9728 PRM | Final | control-plane + static examples | `WWW-Authenticate` on the demo resource |
| ID-JAG draft-04 | IETF draft | typed seam only | **Disabled by default; not advertised** |
| OID4VP holder | OpenID4VP 1.0 + HAIP 1.0 | Multipaz 0.100.0 (native) | Vault selection, consent, verified invocation |
| OID4VCI wallet | OpenID4VCI 1.0 + HAIP 1.0 | Multipaz 0.100.0 (native) | Issuer policy, encrypted custody, verified invocation |
| OID4VP **verifier** | OpenID4VP 1.0 (Final, 2025-07-09) + RFC 9901 + draft-ietf-oauth-sd-jwt-vc-18 | `jose` | `packages/openid4vp` — request construction, DCQL, transaction-data binding, SD-JWT VC verification |
| OID4VCI **issuer** | OpenID4VCI 1.0 (Final, 2025-09-16) + RFC 9901 + draft-ietf-oauth-sd-jwt-vc-18 | `jose` | `packages/openid4vci` — pre-authorized code, JWT proof of possession, `dc+sd-jwt` |

## Draft features (pinned / gated)

| Flag | Default | Fallback |
|------|---------|----------|
| `OPENSESAME_ORIGIN_CLIENTS_ENABLED` | false | Pre-registered clients only |
| `OPENSESAME_CIMD_ENABLED` | false | Reject URL client_ids |
| `OPENSESAME_DCR_ENABLED` | false | `/reg` denied |
| ATProto / Nostr adapters | disabled | Interfaces only until mandatory green |

Do **not** claim OAuth 2.1 RFC compliance; follow RFC 9700 BCP.

## Verifier and issuer roles (ADR 0086)

ADR 0058 makes OpenSesame a *holder*. The wallet-native interaction layer adds
the two server-side roles that let a held credential settle an authorization:
a **verifier** (`packages/openid4vp`) that asks a wallet to prove something and
binds the proof to one request, and an **issuer** (`packages/openid4vci`) that
mints the minimal OpenSesame credential the verifier consumes.

Both export a `SUPPORT_MATRIX` constant naming the exact specification revision,
the response modes, formats and algorithms supported, and — at equal length —
what is deliberately **not** supported and why. **Those constants are the source
of truth.** Cite them; do not paraphrase them here, because a paraphrase drifts
optimistic and this table is what someone will read before making a claim.

Three things worth stating in prose because they are easy to misread:

- **The SD-JWT VC credential profile is a draft**, not an RFC
  (draft-ietf-oauth-sd-jwt-vc, `dc+sd-jwt` and `vct`). The selective-disclosure
  mechanics underneath it are final (RFC 9901). A format bump is possible.
- **mdoc is recognized and refused by name**, not silently unsupported. A real
  mdoc verifier needs CBOR, COSE_Sign1, an MSO, DeviceAuth over a
  per-invocation SessionTranscript, and an IACA chain; a default branch that
  quietly rejected it would read like a bug rather than a decision.
- **HAIP 1.0 conformance is not claimed.** HAIP requires the authorization-code
  flow and wallet key attestations; neither is implemented. The `dc+sd-jwt` and
  ES256/P-256 requirements are met, which is not the same thing.

Verification is bound to the request, not merely to a credential: every request
carries a transaction-data entry naming the OpenSesame request digest, so the
holder's key-binding signature covers a statement about *that* operation. A
presentation whose transaction data was mutated, extended, or bound to a
different digest is refused.

As above, feature flags and repository tests are not certification. No OpenID
Foundation conformance claim may be made from either package's test suite.

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
