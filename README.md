# OpenSesame

Private **authorization fabric** for the agentic era: dual-plane APIs plus a **host/client** product topology (ADR 0017).

1. **Host / authority (Rust)** — `host-core` + Host API (`:8787`): ConnectionRef → authorize → invoke → receipt; daemon; cli[host].
2. **Client (Rust→Wasm + TS)** — `client-core` E2EE sync + `api-client`; extension, PWA, cli[client], client MCP.
3. **Identity (TypeScript)** — Identity API (`:8788`): Better Auth + oidc-provider, principals, claims, passkeys.

Identity and Host APIs stay **separate**. Canonical principals live in OpenSesame domain models (not Better Auth user IDs).

## Quick start — identity plane

```bash
pnpm install
pnpm --filter @opensesame/mock-upstream-idp build
pnpm --filter @opensesame/mock-upstream-idp start   # :9090
# Local/dev: either set a real pepper or allow defaults
export OPENSESAME_ENV=development   # or OPENSESAME_ALLOW_DEV_DEFAULTS=true
# export OPENSESAME_CLAIM_PEPPER=…  # required outside development/test
pnpm --filter @opensesame/control-plane start       # :8788

curl -s http://127.0.0.1:8788/v1/health/live
```

Client CLI: `opensesame-id` (`packages/cli`).

## Quick start — host plane

```bash
cargo build -p opensesame-gateway -p opensesame-cli -p opensesame-daemon
./target/debug/opensesame-gateway --listen 127.0.0.1:8787
./target/debug/opensesame-daemon --listen 127.0.0.1:18790
./target/debug/opensesame daemon status
./target/debug/opensesame login --flow device --no-browser --server http://127.0.0.1:8787

# The Host generates the leaf key and certificate; no PEM input is required.
./target/debug/opensesame cert issue --cn localhost --out-dir .certs
```

Certificate issuance uses the sealed OpenSesame private CA when no external
issuer is configured. Active `letsencrypt` or `zerossl` connections use
Cloudflare DNS-01; `cloudflare-origin-ca` is a separate origin-only issuer.
Production issuance requires durable storage and `OPENSESAME_CONNECTION_KEY`.
External issuer failure never falls back to a different trust class.

## Workspace layout

| Path | Role |
|------|------|
| `crates/core`, `host-core`, `client-core` | WIT/Wasm product SDKs (facades) |
| `apps/gateway` | Host API (:8787) |
| `apps/daemon` | Local host agent (:18790) |
| `apps/cli` | Host CLI `opensesame` |
| `apps/toolbar` | Daemon control stub |
| `apps/control-plane` | Identity API (:8788) |
| `apps/pwa` / `apps/mobile-mfa` | Client PWA + MFA |
| `apps/pages` | GitHub Pages installable offline PWA shell |
| `apps/mcp-client` / `apps/mcp-host` | MCP servers |
| `packages/api-client` | Host API TypeScript client |
| `packages/cli` | Client CLI `opensesame-id` |
| `skills/` | Agent skills (CLIs, MCPs, APIs, extension) |
| `wit/` | Polyglot core contracts |

## Documentation

- Host/client topology: `docs/architecture/host-client-topology.md`
- Identity: `docs/architecture/identity-plane.md`
- ADRs: `docs/adr/` (through 0017)
- Threat models / testing evidence under `docs/`

## Explicit non-goals

Clerk as core IdP; agent `getSecret()`; merging Identity and Host APIs; inventing OAuth/WebAuthn.

## License

MIT — see `LICENSE`.
