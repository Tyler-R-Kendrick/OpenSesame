# ADR 0007: Dual-plane repository — identity (TypeScript) + authority (Rust)

## Status
Accepted

## Context
The repository already contains a Rust authority/credential fabric (ConnectionRef, broker, OpenBao/OpenFGA adapters, ADR 0005–0006). A subsequent implementation brief requires a Shoo/Lakebed-style identity broker on Node.js 24 with Better Auth (upstream) and panva/oidc-provider (downstream).

## Decision
1. **Preserve** the Rust workspace (`crates/`, `apps/gateway`, `apps/cli` Rust binary, etc.) as the **authority plane**.
2. **Add** a TypeScript/pnpm identity plane for principals, claims, OIDC issuer, console, and examples as specified in the identity brief.
3. **Do not** adopt Vercel Marketplace Clerk/Descope/Auth0 for core (ADR 0004). Upstream human auth uses Better Auth + local mock OIDC (+ Keycloak optional).
4. Shared product name OpenSesame; env prefix `OPENSESAME_*`; identity issuer is the standards-facing OIDC entry; authority plane remains ConnectionRef-centric.
5. Future ConnectionRef claiming hooks into claim events (`connection.claimed`) without implementing secret retrieval in this slice.

## Consequences
- Root has both `Cargo.toml` and `package.json` / `pnpm-workspace.yaml`.
- CI runs Rust battle tests and `pnpm test:all`.
- Docs distinguish identity plane vs authority plane.
