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
| WebAuthn L3 + PRF | Final | Vault unlock (PRF when reported) | `crates/human-vault`, `apps/pages` vault unlock |
| FIDO CXF (Credential Exchange Format) | Draft | Passkey import/export; CXP deferred | `apps/pages` vault import/export |
| SCIM 2.0 | Final | When directory sync enabled | future IdP sync path |
| AuthZEN 1.0 | Final | External PDP contract | `crates/authz` |
| SPIFFE Workload API | Final | Workload identity model only | `crates/domain` |
| ACME | Final | Planned | — |
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
