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
| RFC 9449 DPoP | Final | Where supported | authn + credential-agent |
| RFC 8705 mTLS bound tokens | Final | Where supported | mesh/gateway |
| RFC 9470 Step-up | Final | Structured challenge | gateway PEP |
| RFC 9126 PAR | Final | When required by provider | connectors |
| RFC 7009 / 7662 Revocation/Introspection | Final | Session lifecycle | authn |
| OIDC Core / Discovery | Final | IdP integration | `crates/authn`, `apps/gateway` |
| OIDC CIBA | Final | Optional provider capability | CLI flow resolver |
| WebAuthn L3 + PRF | Final | Vault unlock (PRF when reported) | `crates/human-vault`, `apps/pages` |
| FIDO CXF | Draft/experimental | Proposed Standard, still stabilizing; passkey import/export | `apps/pages` |
| SCIM 2.0 | Final | When directory sync enabled | future IdP sync path |
| AuthZEN 1.0 | Final | External PDP contract | `crates/authz` |
| SPIFFE Workload API | Final | Workload identity model only | `crates/domain` |
| RFC 5280 X.509 / CRL | Final | Issuance + CRL v2 with `CRLReason`, CDP/AIA extensions; documented subset, not certified | `crates/pki-core`, `apps/gateway/src/routes/revocation.rs` |
| RFC 8555 ACME (client) | Final | DNS-01 only; HTTP-01 and TLS-ALPN-01 refused (ADR 0068 §6) | `apps/gateway/src/cert_issuers/acme.rs` |
| RFC 8555 ACME (server) | Final | Profile-scoped directory; EAB required; HTTP-01 or admin-enabled skip-validation | `apps/gateway/src/routes/acme_server.rs` |
| RFC 7030 EST | Final | Server: `cacerts` / `simpleenroll` / `simplereenroll`; passphrase, bootstrap chain, mTLS re-enroll | `apps/gateway/src/routes/est_server.rs` |
| RFC 8894 SCEP | Final | Server: `GetCACaps` / `GetCACert` / `PKIOperation`; static + one-time dynamic challenges | `apps/gateway/src/routes/scep_server.rs`, `crates/scep` |
| RFC 6960 OCSP | Final | Responder; CA-direct or `id-kp-OCSPSigning` delegate. Deliberate differentiator (ADR 0067) | `apps/gateway/src/routes/revocation.rs` |
| RFC 7468 PEM encodings | Final | Certificate / chain / CSR textual encoding | `crates/pki-core` |
| RFC 7292 PKCS#12 | Final | Password-encrypted build; multi-entry parse for import | `crates/pki-core` |
| PKCS#11 v2.40 | Final | HSM client (`cryptoki`) + sign-only provider module; SoftHSM2 is the CI target, not hardware | `crates/hsm-client`, `crates/pkcs11-provider` |
| ACME | Final | Superseded by the two RFC 8555 rows above | `apps/gateway/src/cert_issuers` |
| OpenAPI 3.1 | Final | Generated contracts | `api/openapi` |
| CloudEvents | Final | Lifecycle events | `api/events` |
| WASI Component Model / WIT | Final | Connector boundary | `wit/` |
| MCP authorization (2026-07-28) | Ecosystem | Adapter over PRM | gateway MCP surface |
| auth.md | Ecosystem | Generated from typed config | gateway |
| A2A Agent Card | Ecosystem | Namespaced metadata | gateway |
| AT Protocol OAuth / DID | Ecosystem | Connector + identity adapter | connectors/atproto |
| Nostr NIP-46/47/98 | Ecosystem | Signer connector | connectors/nostr-signer |
| OAuth 2.1 / ID-JAG / Txn Tokens / WIMSE / WIT-SVID | Draft/experimental | Adapter only; no schema lock-in | evidence envelopes |

Draft claim names are never first-class DB columns; store `IdentityEvidence` digests.

"Support stance" describes the profile OpenSesame implements. Per
[docs/protocol-conformance.md](protocol-conformance.md), repository evidence
establishes an implementation profile only — it is never a conformance
certification, and none is claimed. The certificate-plane locations
`crates/pki-core`, `crates/scep`, `crates/hsm-client`, `crates/pkcs11-provider`
and the `certmgr`/enrollment route modules are created by the Certificate
Manager work recorded in ADR 0066–0072; validation depth per area is in
[docs/validation/certificate-manager.md](validation/certificate-manager.md).
