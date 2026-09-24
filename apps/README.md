# apps/

Everything here ships or runs: services, binaries, and user interfaces. The
libraries they are built from live in [`crates/`](../crates/README.md) (Rust)
and [`packages/`](../packages/README.md) (TypeScript). Integrations built only
on the public SDKs are in [`examples/`](../examples/README.md); development
servers such as the mock IdP are in [`tools/`](../tools/README.md).

## Host / authority plane (Rust)

| App | Binary | Port | Purpose |
|---|---|---|---|
| [`gateway`](gateway) | `opensesame-gateway` | 8787 | **Host API.** ConnectionRef → authorize → invoke → receipt; sync blob store; certificates; backups; the operator transport routes. |
| [`daemon`](daemon) | `opensesame-daemon` | 18790 | **Local host agent.** Short-lived session capabilities for devcontainers, WSL, the toolbar and credential helpers, over loopback or a Unix socket. |
| [`cli`](cli) | `opensesame` | — | **Host CLI.** Login, daemon control, connections, certificates, and the `pass`-compatible sealed store. |
| [`credential-helpers`](credential-helpers) | `git-credential-opensesame`, … | — | git, Docker, AWS and kubectl credential helpers — thin clients of the daemon's mint path ([ADR 0049](../docs/adr/0049-derived-short-lived-materialization.md)). |
| [`pm-bridges`](pm-bridges) | per-feature | — | Local-IPC bridges that let KeePassXC-protocol, browserpass, gopass and Secret Service clients use the sealed store. All off by default ([ADR 0053](../docs/adr/0053-pm-bridge-binaries.md)). |
| [`callback-edge`](callback-edge) | `opensesame-callback-edge` | — | Narrow ingress for signed provider callbacks; it can neither read a vault nor start work. |
| [`toolbar`](toolbar) | `opensesame-toolbar` | — | Minimal operator toolbar: health, status, approvals — through the daemon only. |
| [`worker`](worker) | `opensesame-worker` | — | Background worker: the Rust workload connector host plus the TypeScript cleanup, notification and TaskBus loop. |

## Identity plane (TypeScript)

| App | Package | Port | Purpose |
|---|---|---|---|
| [`control-plane`](control-plane) | `@opensesame/control-plane` | 8788 | **Identity API.** OIDC issuer (oidc-provider), Better Auth upstream sign-in, principals, passkeys, claims, device authorization, SCIM, notifications. Writes `openapi.json`. |
| [`console`](console) | `@opensesame/console` | 5173 | Operator console for the Identity API. |
| [`ceremonies`](ceremonies) | `@opensesame/ceremonies` | 5181 | Hosted ceremony pages — one complete, shareable ceremony per route ([ADR 0045](../docs/adr/0045-hosted-ceremony-pages.md)). |
| [`mobile-mfa`](mobile-mfa) | `@opensesame/mobile-mfa` | — | The phone half of a cross-device approval, and where its authenticators are enrolled. |

## Client plane

| App | Package | Port | Purpose |
|---|---|---|---|
| [`pages`](pages) | `@opensesame/pages` | 5180 | **The OpenSesame app.** Installable offline PWA published to GitHub Pages: vault, connections, agents, access, identity, sites, settings. Complete with no backend. |
| [`pwa`](pwa) | `@opensesame/pwa` | — | Minimal client PWA against the Host API and client-core sync. |
| [`browser-extension`](browser-extension) | `@opensesame/browser-extension` | — | WXT browser extension: Host API, sync cursor, optional daemon. Never exposes a secret to a web page. |
| [`mcp-host`](mcp-host) | `@opensesame/mcp-host` | stdio / HTTP | Operator MCP server over the Host API and daemon. |
| [`mcp-client`](mcp-client) | `@opensesame/mcp-client` | stdio | Agent MCP server over a narrowly scoped, short-lived Host capability. |
| [`authenticator-native`](authenticator-native) | `@opensesame/authenticator-native-contract` | — | Android authenticator: OpenID4VC holder through Multipaz, and the contract tests the web app holds it to. |
| [`connect-backend`](connect-backend) | `@opensesame/connect-backend` | — | Relay for Connect OAuth callbacks and GitHub App manifests, for deployments that host one. |

Neither MCP server exposes `getSecret()` or materializes a credential
([ADR 0005](../docs/adr/0005-authority-handle-connectionref.md)).

## Running

```bash
pnpm --filter @opensesame/pages dev:web                     # the app, no backend
pnpm --filter @opensesame/pages dev                          # app + Host + Identity + mock IdP
pnpm --filter @opensesame/control-plane start                # Identity API
cargo run -p opensesame-gateway -- --listen 127.0.0.1:8787   # Host API
cargo run -p opensesame-cli -- --help                        # host CLI
```

`pnpm dev` starts the Identity plane, the console, ceremonies, worker, mock
IdP and example relying parties together. More in
[getting started](../docs/getting-started/README.md).

## Adding an app

TypeScript apps are picked up by the `apps/*` glob in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). Rust apps need an entry in
`members` in the root [`Cargo.toml`](../Cargo.toml). Every new user-facing
capability also needs a [`capability-registry`](../packages/capability-registry)
entry ([ADR 0065](../docs/adr/0065-agent-surface-parity.md)).
