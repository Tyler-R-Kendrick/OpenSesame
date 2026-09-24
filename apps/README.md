# apps/

Everything here ships or runs: services, binaries, and user interfaces. The
libraries they are built from live in [`crates/`](../crates/README.md) (Rust)
and [`packages/`](../packages/README.md) (TypeScript). Integrations built only
on the public SDKs are in [`examples/`](../examples/README.md); development
servers such as the mock IdP are in [`tools/`](../tools/README.md).

## Native binary (Rust)

One binary, `opensesame`, built from [`cli`](cli). Every native role is a
subcommand of it, and every helper a caller launches by a fixed name is a link
to it ([ADR 0138](../docs/adr/0138-self-issued-identity-one-native-host.md)).

| Role | Run as | Port | Library |
|---|---|---|---|
| **Host API** — ConnectionRef → authorize → invoke → receipt; sync blob store; certificates; backups; signed provider callbacks | `opensesame host run` | 8787 | [`crates/gateway`](../crates/gateway) |
| **Local host agent** — short-lived session capabilities for devcontainers, WSL and credential helpers, over loopback or a Unix socket; status and approvals through `opensesame daemon info / approve-device / approve-claim` | `opensesame daemon run` | 18790 | [`crates/daemon`](../crates/daemon) |
| **Workload connector host** — readiness and provider listing behind a token or mTLS ([ADR 0132](../docs/adr/0132-optional-mtls-and-workload-identity.md)) | `opensesame worker run` | 8790 | [`crates/worker`](../crates/worker) |
| **Credential helpers** — git, Docker, AWS and kubectl, thin clients of the daemon's mint path ([ADR 0049](../docs/adr/0049-derived-short-lived-materialization.md)) | `git-credential-opensesame`, `docker-credential-opensesame`, `opensesame-credential-process`, `opensesame-kube-exec` | — | [`crates/credential-helpers`](../crates/credential-helpers) |
| **Password-manager bridges** — browserpass, gopass and keepassxc-protocol clients on the sealed store; cargo features, all off by default ([ADR 0053](../docs/adr/0053-pm-bridge-binaries.md)) | `opensesame-browserpass-host`, `opensesame-gopass-jsonapi`, `opensesame-keepassxc-bridge` | — | [`crates/pm-bridges`](../crates/pm-bridges) |
| **CLI** — login, connections, certificates, the `pass`-compatible sealed store | `opensesame …` | — | — |

`opensesame helpers link [--dir DIR]` creates the helper names as links to the
binary; the name a process starts under picks the program
([`cli/src/entry.rs`](cli/src/entry.rs)).

## Identity plane (TypeScript)

| App | Package | Port | Purpose |
|---|---|---|---|
| [`console`](console) | `@opensesame/console` | 5173 | Operator console for the Identity API. |
| [`ceremonies`](ceremonies) | `@opensesame/ceremonies` | 5181 | Hosted ceremony pages — one complete, shareable ceremony per route ([ADR 0045](../docs/adr/0045-hosted-ceremony-pages.md)). |
| [`mobile-mfa`](mobile-mfa) | `@opensesame/mobile-mfa` | — | The phone half of a cross-device approval, and where its authenticators are enrolled. |

## Client plane

| App | Package | Port | Purpose |
|---|---|---|---|
| [`pages`](pages) | `@opensesame/pages` | 5180 | **The OpenSesame app.** Installable offline PWA published to GitHub Pages: vault, connections, agents, access, identity, sites, settings. Complete with no backend. |
| [`browser-extension`](browser-extension) | `@opensesame/browser-extension` | — | WXT browser extension: Host API, sync cursor, optional daemon. Never exposes a secret to a web page. |
| [`android`](android) | `@opensesame/android` | — | **The Android app** (was `authenticator-native`, [ADR 0138](../docs/adr/0138-self-issued-identity-one-native-host.md)): OpenID4VC holder through Multipaz, and the contract tests the web app holds it to. Its `ios/` sources are the matching Apple wallet extension. |

## Deployed example

| App | Package | Purpose |
|---|---|---|
| [`example-siop-rp`](example-siop-rp) | `@opensesame/example-siop-rp` | The SIOPv2 relying-party example ([`examples/`](../examples/README.md) lists it with the others). It stays here because the `open-sesame` Vercel project's Root Directory is `apps/example-siop-rp`; move it only together with that setting. |

The two MCP servers are packages served by the client CLI
(`opensesame-id mcp host|client`): [`packages/mcp-host`](../packages/mcp-host)
and [`packages/mcp-client`](../packages/mcp-client). Neither exposes
`getSecret()` or materializes a credential
([ADR 0005](../docs/adr/0005-authority-handle-connectionref.md)).

## Running

```bash
pnpm --filter @opensesame/pages dev:web                     # the app, no backend
pnpm --filter @opensesame/pages dev                          # app + Host + Identity + mock IdP
pnpm --filter @opensesame/control-plane start                # Identity API
cargo run -p opensesame-cli -- host run --listen 127.0.0.1:8787   # Host API
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
