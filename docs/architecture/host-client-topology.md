# Host/Client product topology

OpenSesame splits into **host** (machine-local privileged control) and **client** (user devices with E2EE sync), with **two separate APIs**.

| Surface | Port | Role |
|---------|------|------|
| Host API (`apps/gateway`) | 8787 | ConnectionRef invoke, sync blob store, authority |
| Identity API (`apps/control-plane`) | 8788 | OIDC issuer, principals, claims, passkeys |
| Daemon (`apps/daemon`) | 18790 | Local session capabilities for WSL/devcontainers/toolbar |
| Mock upstream IdP | 9090 | Local OIDC for identity tests |

## Dependency graph

```text
core (WIT + Rust)
  ├── host-core  → Host API, daemon, cli[host], host MCP
  └── client-core (native + wasm)
        └── api-client → extension, cli[client], PWA, client MCP

Identity SDKs (sdk-browser/cli/server) → Identity API only
mobile-mfa → Identity API (passkey/TOTP step-up)
toolbar → daemon only
PWA optionally discovers daemon; degrades if absent
```

## CLIs

| Binary | Plane | Package |
|--------|-------|---------|
| `opensesame` | host | `apps/cli` |
| `opensesame-id` | client / identity | `packages/cli` |

## WIT

- `wit/connector/world.wit` — connector guest (no secrets.get)
- `wit/core/world.wit` — shared IR handles
- `wit/host/world.wit` — host capability world
- `wit/client/world.wit` — client vault/sync world

See ADR 0017.
