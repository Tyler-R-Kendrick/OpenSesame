# Standards Matrix

| Standard | Status | Support stance | Location |
|----------|--------|----------------|----------|
| RFC 8628 Device Authorization | Final | First-class CLI | `crates/authn`, `apps/cli` |
| RFC 8252 Native Apps | Final | Loopback + PKCE S256 | `crates/authn` |
| RFC 9700 OAuth BCP | BCP | Applied to AS client config | `crates/authn`, docs |
| RFC 8414 AS Metadata | Final | Discovery | gateway discovery |
| RFC 9728 Protected Resource Metadata | Final | `/.well-known/oauth-protected-resource` | `apps/gateway` |
| RFC 8707 Resource Indicators | Final | Audience validation | `crates/authn` |
| RFC 8693 Token Exchange | Final | When issuer supports | provider adapter |
| RFC 9068 JWT Access Token Profile | Final | When JWT AT used | `crates/authn` |
| RFC 9396 RAR | Final | authorization_details when supported | grants compiler |
| RFC 9449 DPoP | Final | Browser/CLI proof-of-possession baseline; unchanged by ADR 0132, never stripped in favor of a certificate | `packages/oauth-provider`, `apps/gateway/src/middleware/auth.rs`, `crates/authn`, credential-agent |
| RFC 8705 mTLS client auth + certificate-bound tokens | Final | Client authentication (`tls_client_auth`) for explicitly registered certificate-capable clients, and `cnf.x5t#S256` access-token binding, on Identity's optional TLS listener; resource-side check in Identity's protected routes and in Host caller resolution, bound to the originating leaf (never the ingress's, never a JWK thumbprint). Public PKCE/DPoP clients unaffected. No self-service trust-root registration (ADR 0132 §7–8) | `packages/oauth-provider`, `apps/control-plane/src/transport`, `apps/gateway/src/middleware/auth.rs` |
| RFC 9470 Step-up | Final | Structured challenge | gateway PEP |
| RFC 9440 Client-Cert HTTP fields | Final | Origin accepts `Client-Cert` (singleton) and `Client-Cert-Chain` (list, may span physical headers) only on a `trusted_ingress` listener from a peer bound with purpose `trusted_ingress`; bounded decode; caller-supplied fields stripped at the edge; evidence labelled `trusted_ingress_assertion` and request-local. Reference ingress is Caddy (ADR 0132 §8) | `crates/ingress-evidence`, `packages/ingress-evidence`, `ops/ingress/` |
| RFC 9525 Service identity | Final | DNS reference identity for `webpki_dns` profiles: lowercase exact match, no wildcard selectors; SPIFFE profiles substitute the URI-SAN reference identity and keep chain and signature validation | `crates/transport-security` (rustls/webpki), `crates/domain/src/transport/selector.rs` |
| RFC 9325 TLS BCP | BCP | Product profile, not a conformance claim: TLS 1.3 default, TLS 1.2 only by explicit `*_MIN_VERSION=1.2` with rustls safe defaults, nothing older; resumption, tickets and 0-RTT disabled on `mtls_required` / `trusted_ingress` server profiles (ADR 0132 §10) | `crates/transport-security` |
| NATS auth callout (native, ADR-26) | Ecosystem | `$SYS.REQ.USER.AUTH` request/response with NKey/JWT verification, one-time user key, server context and response binding; Host verifies the user's upstream token itself. `opensesame.callout.>` is an unrelated internal namespace. Client mTLS (`verify: true`) and certificate mapping (`verify_and_map: true`) are distinct server profiles; client connections only (ADR 0132 §8) | `crates/nats-callout`, `apps/gateway/src/routes/nats_callout*.rs`, `ops/nats/` |
| RFC 9126 PAR | Final | When required by provider | connectors |
| RFC 7009 / 7662 Revocation/Introspection | Final | Session lifecycle | authn |
| OIDC Core / Discovery | Final | IdP integration | `crates/authn`, `apps/gateway` |
| OIDC CIBA | Final | Optional provider capability | CLI flow resolver |
| WebAuthn L3 + PRF | Final | Vault unlock (PRF when reported) | `crates/human-vault`, `apps/pages` |
| FIDO CXF | Draft/experimental | Proposed Standard, still stabilizing; passkey import/export | `apps/pages` |
| SCIM 2.0 | Final | When directory sync enabled | future IdP sync path |
| AuthZEN 1.0 | Final | External PDP contract | `crates/authz` |
| SPIFFE X.509-SVID + Workload API | Final | X.509-SVID consumption via the Workload API (`spiffe` crate): exact configured SPIFFE ID, per-trust-domain bundles (no union), snapshot replacement, `workload_api_delivered` custody stated as software custody. SPIRE is an optional issuer, never a baseline dependency; no SPIRE server or attestation is implemented (ADR 0132 §2–3) | `crates/spiffe-source`, `crates/transport-security` (SPIFFE verifier), `crates/domain/src/transport` |
| RFC 5280 X.509 / CRL | Final | Issuance + CRL v2 with `CRLReason`, CDP/AIA extensions; documented subset, not certified. Transport-side path validation is rustls/webpki (ADR 0132 §3) | `crates/pki-core`, `crates/pki-core/src/revocation.rs`, `crates/storage/src/revocation.rs`, `crates/transport-security` |
| RFC 8555 ACME (client) | Final | DNS-01 only; HTTP-01 and TLS-ALPN-01 refused (ADR 0068 §6) | `apps/gateway/src/cert_issuers/acme.rs` |
| RFC 8555 ACME (server) | Final | **Not served.** ADR 0068 §1 design; account/order/nonce persistence exists but no route module (`apps/gateway/src/routes/acme_server.rs` does not exist) | `crates/storage/src/acme.rs` (persistence only) |
| RFC 7030 EST | Final | **Absent — unsupported.** No EST server or client exists in the tree; `apps/gateway/src/routes/est_server.rs` (named by ADR 0068 §4 as forthcoming) was never created and is not a prerequisite of mTLS (ADR 0132 §14) | — |
| RFC 8894 SCEP | Final | **Absent — unsupported.** ADR 0068 §4 design; neither `apps/gateway/src/routes/scep_server.rs` nor `crates/scep` exists | — |
| RFC 6960 OCSP | Final | Request/response build, parse and verify; CA-direct or `id-kp-OCSPSigning` delegate (ADR 0067). Library level: no `/ocsp/{caId}` route is mounted in the gateway at this baseline | `crates/pki-core/src/revocation.rs` |
| RFC 7468 PEM encodings | Final | Certificate / chain / CSR textual encoding | `crates/pki-core` |
| RFC 7292 PKCS#12 | Final | Password-encrypted build; multi-entry parse for import | `crates/pki-core` |
| PKCS#11 v2.40 | Final | **Absent — unsupported.** ADR 0071 design; no `cryptoki` dependency and neither `crates/hsm-client` nor `crates/pkcs11-provider` exists. No HSM or KMS signer implements TLS signing; transport identities are software custody only (ADR 0132 §2) | — |
| ACME | Final | Superseded by the two RFC 8555 rows above | `apps/gateway/src/cert_issuers` |
| OpenAPI 3.1 | Final | Host contract + generated Identity contract | `spec/openapi/host-api.yaml`, `apps/control-plane/openapi.json` |
| CloudEvents | Final | Lifecycle events | `api/events` |
| WASI Component Model / WIT | Final | Connector boundary | `spec/wit/` |
| MCP authorization (2026-07-28) | Ecosystem | Adapter over PRM | gateway MCP surface |
| auth.md | Ecosystem | Generated from typed config; AgentAuth adapter (ADR 0092) | `apps/control-plane`, `packages/agent-protocols` |
| RFC 7523 JWT bearer | Final | AgentAuth service-assertion exchange | `apps/control-plane` `/oauth2/token` |
| draft-ietf-oauth-identity-assertion-authz-grant-04 | IETF draft | Sealed behind feature flag; not advertised | `packages/agent-protocols` |
| A2A Agent Card | Ecosystem | Namespaced metadata | gateway |
| AT Protocol OAuth / DID | Ecosystem | Connector + identity adapter | connectors/atproto |
| Nostr NIP-46/47/98 | Ecosystem | Signer connector | connectors/nostr-signer |
| OpenID4VP 1.0 (verifier) | Final (2025-07-09) | `direct_post` + DC API, DCQL, `dc+sd-jwt`; mdoc and encrypted response modes refused by name (ADR 0086) | `packages/openid4vp` |
| OpenID4VCI 1.0 (issuer) | Final (2025-09-16) | Pre-authorized code + JWT proof only; no batch, deferred, status list or key attestation (ADR 0086) | `packages/openid4vci` |
| RFC 9901 SD-JWT | Final | Disclosure digests and key binding, used by both roles above | `packages/openid4vp`, `packages/openid4vci` |
| SD-JWT VC (`dc+sd-jwt`) | Draft/experimental | draft-ietf-oauth-sd-jwt-vc; isolated behind the issuer's format profile, revision pinned in `SUPPORT_MATRIX` | `packages/openid4vci` |
| Google Wallet Generic Pass | Vendor | Presentation adapter only; a pass carries an opaque interaction reference and never a credential (ADR 0086) | `packages/wallet` |
| OAuth 2.1 / ID-JAG / Txn Tokens / WIMSE / WIT-SVID | Draft/experimental | Adapter only; no schema lock-in | evidence envelopes |

Draft claim names are never first-class DB columns; store `IdentityEvidence` digests.

"Support stance" describes the profile OpenSesame implements. Per
[docs/reference/protocol-conformance.md](protocol-conformance.md), repository evidence
establishes an implementation profile only — it is never a conformance
certification, and none is claimed. The certificate-plane locations
named by ADR 0066–0072 are only partly present at this baseline: `crates/pki-core`,
the `certmgr_*` route modules and the ACME/revocation persistence exist;
`crates/scep`, `crates/hsm-client`, `crates/pkcs11-provider` and the ACME/EST/SCEP
route modules do not, and the rows above say so rather than naming a file that
is not there. Validation depth per area is in
[docs/validation/certificate-manager.md](../validation/certificate-manager.md);
transport-security evidence is in
[docs/validation/mtls-implementation.md](../validation/mtls-implementation.md)
([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). The ADR 0132
rows name the owning locations from its implementation contract; at the
2026-09-22 reconciliation `crates/nats-callout`, `ops/nats/`,
`apps/gateway/src/transport` and the Host-side `cnf` check in
`apps/gateway/src/middleware/auth.rs` were not yet in the tree — ADR 0132
§ Evidence records which locations were present and which suites ran.
