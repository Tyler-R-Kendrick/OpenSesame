# ADR 0006: @env-spec developer contract and credential delivery modes

## Status
Accepted

## Context
Varlock / `@env-spec` provide a durable, MIT-licensed developer config surface (`.env.schema`) with schema/value separation, shaped placeholders, and a credential-proxy preview. OpenSesame already centers agent authority on ConnectionRef + Intent (ADR 0005). Reinventing a custom env DSL would violate anti-NIH; cloning Varlock’s HTTPS MITM as the primary broker would inherit protocol limits and a weak same-UID security boundary.

## Decision
1. **Preferred project contract is committed `.env.schema` (`@env-spec`).** Do not invent `.vault/env.yaml` / `vault.config.json` as the primary surface.
2. Parse via official **`@env-spec/parser`** (Node bridge); Rust consumes JSON AST — no DSL reimplementation.
3. OpenSesame resolvers in schema values:
   - `opensesame(conn://…)`
   - `opensesameConnection(conn://…, projection=legacy-token)`
4. Four **CredentialDeliveryMode** values:
   - `materialize` — real secret (legacy; requires export privilege)
   - `placeholder` — shaped fake + placement-bound egress substitution
   - `handle` — ConnectionRef / opaque handle
   - `native` — federation / signer / SPIFFE (no credential in env)
5. Agent/dev defaults **deny `materialize`**. Placeholder substitution is **placement-constrained** (header/path/query/body field + max occurrences) — never generic string replace.
6. Varlock remains a **compatibility peer** (run/proxy/sandbox prior art). Official `@varlock/opensesame` plugin is Path A (follow-up when third-party plugins open).
7. Optional thin `opensesame.toml` only for delivery policy / grants that `@env-spec` cannot express.
8. Host credential-agent issues short-lived **session capabilities** to WSL/devcontainers — not refresh tokens or secret-zero.

## Consequences
- CLI: `opensesame dev check|resolve|run|--agent`
- Domain + connector-host enforce delivery modes and placement
- REUSE lists `@env-spec/parser`; Varlock is integrate/peer, not fork
- MITM proxy is non-goal for this slice
