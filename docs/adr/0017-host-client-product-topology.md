# ADR 0017: Host/Client product topology

## Status
Accepted

## Context
OpenSesame is a dual-plane system (ADR 0007): TypeScript Identity API and Rust Host/Authority API. Product surfaces (daemon, toolbar, extension, PWA, MCP, CLIs) need a clear host vs client split with a polyglot core.

## Decision
1. **Identity API** (`apps/control-plane`, :8788) and **Host API** (`apps/gateway`, :8787) remain **separate**. No BFF merge.
2. **Polyglot boundary = WIT/Wasm.** Shared IR lives in `wit/` + `crates/core`.
3. **host-core** (`crates/host-core`) is Rust: authorize → invoke → receipt, connectors, daemon capabilities.
4. **client-core** (`crates/client-core` + `packages/client-core`) is Rust native + `wasm32` with JS bindings: E2EE vault, local encrypted replication/sync.
5. TypeScript owns HTTP api-client, MCP servers, extension, PWA UX, and Identity SDKs.
6. **Daemon** evolves from `credential-agent`; **cli[host]** (`opensesame`) installs/controls it; **cli[client]** (`opensesame-id`) uses api-client + Identity SDKs.
7. Agent-facing APIs use ConnectionRef + Intent (ADR 0005). No public `getSecret`.

## Consequences
- Facade crates re-export existing modules to avoid a big-bang move.
- Sync stores opaque ciphertext only on the Host API.
- Agent skills document both APIs and both CLIs with accurate ports.
