# Protocol profiles

OpenSesame maps external authorization standards to internal [`ProtocolProfile`] values in `opensesame-domain`. Profiles define minimum token presentation, downgrade policy, and task-binding requirements.

## Profile matrix

| Slug | Family | Maturity | Min presentation | Task binding | Replay protection | Adapter crate | Notes |
|------|--------|----------|------------------|--------------|-------------------|---------------|-------|
| `opensesame-task-dpop-rfc9449-v1` | OpenSesame task | Stable | DPoP-bound | Yes | Yes | `opensesame-proof`, `opensesame-task-access` | Default for task-secured broker invocations |
| `oauth-bearer-rfc6750-v1` | OAuth | Stable | Bearer | No | No | — | Generic RFC 6750 resource servers |
| `mcp-authorization-2026-07-28-bearer` | MCP | **Draft** | Bearer | No | No | `opensesame-protocol-mcp` | MCP spec still evolving; Bearer-only in this repo |
| `oauth-token-exchange-rfc8693-semantics-v1` | OAuth | Stable | Bearer | No | No | — | Semantic mapping only; no token-exchange server in this slice |
| `http-message-signatures-rfc9421-v1` | HTTP sig | Stable | HTTP message signature | No | Yes | `opensesame-proof` | Ed25519 subset: `content-digest`, `@method`, `@target-uri` only |
| `aauth-draft-10-experimental` | Experimental | **Experimental** | DPoP-bound | Yes | Yes | `opensesame-protocol-aauth` (feature `experimental-aauth`) | Draft-10; disabled by default |

## Downgrade policy

All built-in profiles use `DowngradePolicy::FailClosed`. Presenting Bearer where DPoP is required returns `TokenPresentationDowngrade`. MCP Bearer must not be confused with OpenSesame task DPoP profiles (see ADR 0023).

## Honesty about draft and experimental features

- **MCP Authorization (2026-07-28)** — Implemented as Bearer validation and scope stubs only. No DPoP profile for MCP in this repository. Audience/resource helpers exist; full MCP authorization server is out of scope.
- **AAuth draft-10** — Feature-gated experimental adapter. Types and lossless mappings are tested; no public endpoints. Spec changes may break the adapter without a major version bump.
- **HTTP message signatures** — `LocalHttpMessageSignatureValidator` in `opensesame-proof` implements the OpenSesame subset (Ed25519 over `content-digest`, `@method`, `@target-uri`). Not full RFC 9421 component interoperability; see limitations below.
- **Token exchange semantics** — Profile id for documentation; no RFC 8693 endpoint.

## Token passthrough

OpenSesame **never** forwards an inbound presented token as a downstream credential. MCP adapter exposes an explicit rejection path for passthrough attempts. Task-scoped credentials are minted by the credential-agent with digest-only persistence.

## Related ADRs

- ADR 0023 — MCP Bearer vs DPoP
- ADR 0025 — AAuth experimental
- ADR 0029 — Protocol token identity
- ADR 0030 — Verification evidence

## Verification

```bash
cargo +1.88.0 test -p opensesame-domain
cargo +1.88.0 test -p opensesame-protocol-mcp
cargo +1.88.0 test -p opensesame-protocol-aauth --features experimental-aauth
```
