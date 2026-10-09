# apps/

Everything here ships or runs: the native binary and the client apps. The
Host API, the local host agent and the workload connector host are libraries
the binary serves; the Identity API and the MCP servers are TypeScript
packages. The libraries live in [`crates/`](../crates/README.md) (Rust) and
[`packages/`](../packages/README.md) (TypeScript). Integrations built only
on the public SDKs are in [`examples/`](../examples/README.md); development
servers such as the mock IdP are in [`tools/`](../tools/README.md).

## Native binary (Rust)

One binary, `opensesame`, built from [`cli`](cli) (Cargo package
`opensesame-cli`). Every native role is a subcommand of it, and every helper a
caller launches by a fixed name is a link to it
([ADR 0138](../docs/adr/0138-self-issued-identity-one-native-host.md)).

| Role | Run as | Port | Library |
|---|---|---|---|
| **Host API** — ConnectionRef → authorize → invoke → receipt; sync blob store; certificates; backups; signed provider callbacks | `opensesame host run` | 8787 | [`crates/gateway`](../crates/gateway) |
| **Local host agent** — short-lived session capabilities for devcontainers, WSL and credential helpers, over loopback or a Unix socket; status and approvals through `opensesame daemon info / approve-device / approve-claim` | `opensesame daemon run` | 18790 | [`crates/daemon`](../crates/daemon) |
| **Workload connector host** — readiness and provider listing behind a token or mTLS ([ADR 0132](../docs/adr/0132-optional-mtls-and-workload-identity.md)) | `opensesame worker run` | 8790 | [`crates/worker`](../crates/worker) |
| **Credential helpers** — git, Docker, AWS and kubectl, thin clients of the daemon's mint path ([ADR 0049](../docs/adr/0049-derived-short-lived-materialization.md)) | link names `git-credential-opensesame`, `docker-credential-opensesame`, `opensesame-credential-process`, `opensesame-kube-exec` | — | [`crates/credential-helpers`](../crates/credential-helpers) |
| **Password-manager bridges** — browserpass, gopass and keepassxc-protocol clients on the sealed store; cargo features `browserpass`, `gopass`, `keepassxc`, all off by default ([ADR 0053](../docs/adr/0053-pm-bridge-binaries.md)) | link names `opensesame-browserpass-host`, `opensesame-gopass-jsonapi`, `opensesame-keepassxc-bridge` | — | [`crates/pm-bridges`](../crates/pm-bridges) |
| **CLI** — login, connections, certificates, the `pass`-compatible sealed store | `opensesame …` | — | — |

The helper names are link names answered by the one binary, not crates or
separate builds. `opensesame helpers link [--dir DIR]` creates the ones this
build includes as links to the binary (the three bridge names only when built
with their cargo feature); the name a process starts under picks the program
([`cli/src/entry.rs`](cli/src/entry.rs)).

## Identity plane (TypeScript)

No app. The Identity API is a package,
[`packages/control-plane`](../packages/control-plane), with its worker
[`packages/identity-worker`](../packages/identity-worker). Every ceremony a
link opens (claim, drop, device approval, cross-device approval, the
approval inbox and review, notification routing, the authenticator hand-off)
and the identity console's sign-in and organization settings are routes and
panels of [`pages`](pages)
([ADR 0140](../docs/adr/0140-pages-hosts-every-ceremony.md)).

## Client plane

| App | Package | Port | Purpose |
|---|---|---|---|
| [`pages`](pages) | `@opensesame/pages` | 5180 | **The OpenSesame app.** Installable offline PWA published to GitHub Pages: vault, connections, access, identity, wallet, activity, settings. Complete with no backend. |
| [`browser-extension`](browser-extension) | `@opensesame/browser-extension` | — | WXT browser extension: Host API, sync cursor, optional daemon. Never exposes a secret to a web page. |
| [`browser-extension-autofill`](browser-extension-autofill) | `@opensesame/browser-extension-autofill` | — | **Optional plugin** (`browser-autofill`, [ADR 0150](../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) §7): a companion extension that fills a focused login field by reference, only on sites a person switched on, after a gesture on its own UI. Installed at runtime, never in the default extension. |
| [`android`](android) | `@opensesame/android` | — | **The Android app** (was `authenticator-native`, [ADR 0138](../docs/adr/0138-self-issued-identity-one-native-host.md)): OpenID4VC holder through Multipaz over the Rust `opensesame-authenticator-core` library, with its native contract tests. Its `ios/` sources are the matching Apple wallet app and Identity Document Provider extension. It does not use `@opensesame/app-core` yet. |

The two MCP servers are packages served by the client CLI
(`opensesame-id mcp host|client`): [`packages/mcp-host`](../packages/mcp-host)
and [`packages/mcp-client`](../packages/mcp-client). Neither exposes
`getSecret()` or materializes a credential
([ADR 0005](../docs/adr/0005-authority-handle-connectionref.md)).

## Running

```bash
pnpm dev:pwa                                                 # the app on :5180, no backend
pnpm --filter @opensesame/pages dev                          # app + Host (:18787) + Identity (:18788) + mock IdPs
pnpm dev:host                                                # Host API on 127.0.0.1:8787
pnpm dev:daemon                                              # local host agent on 127.0.0.1:18790
pnpm dev:cli -- --help                                       # host CLI
```

`dev:host`, `dev:daemon` and `dev:cli` source
[`scripts/dev/local-env.sh`](../scripts/dev/local-env.sh), which sets the
deployment mode and generates the operator token, claim pepper and signing
keys under `~/.local/state/opensesame/development/`. A bare
`opensesame host run` or `opensesame daemon run` refuses to start without a
deployment mode (`OPENSESAME_ENV` or `NODE_ENV` of `development`, `test` or
`production`, or `OPENSESAME_ALLOW_DEV_DEFAULTS=1` on a local-only listener)
and an `OPENSESAME_OPERATOR_TOKEN` of 32 or more characters; the Host also
needs `OPENSESAME_CLAIM_PEPPER` of the same strength. The Identity API
(`pnpm --filter @opensesame/control-plane start`, `:8788`) needs a mode and
either `OPENSESAME_CLAIM_PEPPER` or `OPENSESAME_ALLOW_DEV_DEFAULTS=1` (exactly
`1` or `0`, local-only), which also stands in for the mode and generates a
random pepper per process.

`pnpm dev` starts the Identity plane, its worker, the mock IdP and the
example relying parties together. More in
[getting started](../docs/getting-started/README.md).

## Adding an app

TypeScript apps are picked up by the `apps/*` glob in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). Rust apps need an entry in
`members` in the root [`Cargo.toml`](../Cargo.toml). Every new user-facing
capability also needs a [`capability-registry`](../packages/capability-registry)
entry ([ADR 0065](../docs/adr/0065-agent-surface-parity.md)).
