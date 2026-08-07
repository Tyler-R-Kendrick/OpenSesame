# ADR 0005: AuthorityHandle — ConnectionRef over SecretRef

## Status
Accepted

## Context
Industry “SecretRef” patterns (1Password `op://`, K8s CSI, ESO, Dapr) often only delay plaintext exposure into the agent process. OpenClaw/agentgateway/Boundary/CyberArk show gateway-side injection. SUDP (arXiv:2604.24920) argues against “authorization by exposure.” MCP requires separate upstream credentials (no token passthrough). RFC 9396 RAR supports structured operation authorization.

## Decision
1. **Do not standardize agent-facing `SecretRef`.** Agents receive `ConnectionRef` (+ typed Intent).
2. Introduce `AuthorityHandle` taxonomy:
   - `ConnectionRef` (agent API)
   - `CredentialRef` / `KeyRef` / `CertificateAuthorityRef` / `SignerRef` / `SecretRef` (internal)
3. **Invariant:** possessing a handle never implies permission to resolve/export underlying material.
4. Invocation levels:
   - L1 typed operation (default)
   - L2 constrained HTTP on connection egress allowlist (elevated)
   - L3 credential materialization / `resolve` (explicit `raw_credential_export`, normally denied)
5. Gateway is **not** a generic string replacer; credential injection is bound to connection egress (scheme/authority/path) + grant + intent.
6. Prefer federation / remote sign / dynamic lease over static secret injection; SecretRef remains an internal compatibility layer under Connection broker.
7. Study SUDP security properties for custodian execution; do not invent a competing wire protocol for v0.1.

## Consequences
- Domain, broker, authz, WIT, and agent APIs center on ConnectionRef + Intent.
- `secrets.get` is not a guest import; host exposes authorized-http / sign / token-handle ops.
- Rotation keeps stable logical refs (`secret://…/purpose`) with immutable version IDs for audit only.
