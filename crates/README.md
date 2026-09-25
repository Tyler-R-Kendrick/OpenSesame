# crates/

Rust libraries for the **Host / authority plane**. Every crate here is a member
of the root Cargo workspace, is published under the package name
`opensesame-<directory>`, and builds with the pinned Rust 1.88 toolchain.
Binaries that use them live in [`apps/`](../apps/README.md).

```bash
cargo +1.88.0 test -p opensesame-sealed-store      # one crate
cargo +1.88.0 test --workspace --all-targets       # everything (what CI runs)
pnpm audit:clippy                                  # rustfmt + pedantic Clippy
```

Complexity limits come from [`clippy.toml`](../clippy.toml) and match the
TypeScript ones; files stay under 400 lines. `pnpm quality:packages` fails on a
dependency cycle between crates.

## SDK facades

What an application links against. Each re-exports the libraries below it
behind a stable surface ([ADR 0017](../docs/adr/0017-host-client-product-topology.md)).

| Crate | Purpose |
|---|---|
| [`core`](core) | Shared IR with no I/O: the domain model and `AuthorityHandle`, per the `core` WIT world. |
| [`host-core`](host-core) | Host logic facade: broker, authorization, connector host, env-spec, daemon constants. |
| [`client-core`](client-core) | Client SDK: local E2EE and sync cursors; native and Wasm builds. |
| [`domain`](domain) | Canonical domain model: resources, invariants, IDs, errors, transport contracts. |
| [`connector-sdk`](connector-sdk) | Helpers for WIT connector guests — ConnectionRef-oriented, no `secrets.get`. |

## Authorization

| Crate | Purpose |
|---|---|
| [`authn`](authn) | Authentication flows: device authorization, loopback PKCE, workload identity, CIBA selection. |
| [`authz`](authz) | Policy enforcement: OpenFGA relationships plus contextual constraints behind an AuthZEN-shaped API. |
| [`grants`](grants) | Grant compiler: delegation that may only attenuate its parent. |
| [`broker`](broker) | Invocation broker: checks a grant covers a frozen intent before anything runs. |
| [`task-access`](task-access) | The Trust Ratchet task-access engine (SQLite locally, Postgres distributed). |
| [`enforcement`](enforcement) | What a platform actually enforces, stated precisely enough to refuse a grant it cannot hold. |
| [`relay`](relay) | Fail-closed admission rules for relayed execution ([ADR 0046](../docs/adr/0046-relayed-execution-and-authorization-inbox.md)). |
| [`sandbox`](sandbox) | Bounded, brokered execution for general-authority guests. |
| [`proof`](proof) | RFC 9449 DPoP validation and constrained key custody. |
| [`claims`](claims) | Claim and device-code digests and their domain separation. |
| [`audit`](audit) | Signed receipts and receipt-key identifiers. |
| [`redaction`](redaction) | Value-blind redaction of secrets in logs and errors. |
| [`xkeys`](xkeys) | X25519 recipient keys and AEAD for end-to-end-encrypted bus payloads. |

## Connections and providers

| Crate | Purpose |
|---|---|
| [`connection-broker`](connection-broker) | Acquires third-party authorizations and holds them; the connector catalogue. |
| [`connector-host`](connector-host) | Hosts WIT connectors: authorized HTTP, signing and opaque token handles — never a raw secret. |
| [`connection-detect`](connection-detect) | Value-blind discovery of provider credentials already on a machine ([ADR 0047](../docs/adr/0047-daemon-connector-discovery.md)). |
| [`invoke-through`](invoke-through) | Daemon-mediated upstream calls over a credential that never leaves the machine. |
| [`provider-openbao`](provider-openbao) | OpenBao credential-authority adapter. |
| [`provider-openfga`](provider-openfga) | OpenFGA remote PDP client. |
| [`provider-bitwarden`](provider-bitwarden) | Bitwarden / Vaultwarden consume-client ([ADR 0052](../docs/adr/0052-password-manager-ecosystem-bridging.md)). |
| [`bitwarden-server`](bitwarden-server) | Bitwarden-compatible server: Bitwarden clients against the Host, Argon2id, a replaceable server hash ([ADR 0141](../docs/adr/0141-bitwarden-compatible-server.md)). |
| [`provider-static-mesh`](provider-static-mesh) | Static service discovery for tests and Headscale-style deployments. |
| [`collab-adapter`](collab-adapter) | Projects an authority onto a collaboration platform's roles (Discord, bot token only). |
| [`dns-enforcement`](dns-enforcement) | DNS-layer enforcement through Blocky, with an honest statement of its coverage. |

## Storage and vaults

| Crate | Purpose |
|---|---|
| [`storage`](storage) | The Host database (SQLite via SQLx); one module per responsibility, migrations in [`migrations/`](storage/migrations). |
| [`human-vault`](human-vault) | Server-blind E2EE envelopes shared by the vault and the sealed store. |
| [`sealed-store`](sealed-store) | Git-native hierarchical sealed store with `pass` parity, attachments and tombs. |
| [`vault-item-types`](vault-item-types) | Item-type parser and registry; embeds [`marketplace/item-types/builtin`](../marketplace/item-types/builtin). |
| [`kdbx-bridge`](kdbx-bridge) | KeePass KDBX 4 read/write mapped onto the sealed store. |
| [`env-spec`](env-spec) | Consumes `.env.schema` JSON to resolve developer environments without printing values. |

## Transport and workload identity

| Crate | Purpose |
|---|---|
| [`transport-security`](transport-security) | Native TLS: listeners, clients, trust bundles, SPIFFE and RFC 9525 verifiers ([ADR 0132](../docs/adr/0132-optional-mtls-and-workload-identity.md)). |
| [`pki-core`](pki-core) | Provider-agnostic X.509 engine behind the certificate manager. |
| [`spiffe-source`](spiffe-source) | SPIFFE Workload API X.509-SVID source. |
| [`ingress-evidence`](ingress-evidence) | RFC 9440 `Client-Cert` parsing, accepted only from a bound ingress. |
| [`nats-callout`](nats-callout) | NATS auth-callout protocol and the native bridge to the Host decision route. |
| [`uds-authn`](uds-authn) | Unix-socket peer-credential attestation. |
| [`tailscale-authn`](tailscale-authn) | Tailnet caller identity through `tailscaled` whois. |

## Lifecycle, events and rotation

| Crate | Purpose |
|---|---|
| [`lifecycle`](lifecycle) | Expiry ladder and `lifecycle.*` hook events — the one place deadlines are detected ([ADR 0074](../docs/adr/0074-expiry-lifecycle-hooks.md)). |
| [`security-events`](security-events) | The shared `SecurityNotice` envelope and its Alertmanager, PagerDuty and syslog renderings ([ADR 0080](../docs/adr/0080-security-event-hooks.md)). |
| [`breach-intel`](breach-intel) | Value-blind breach detection: Pwned Passwords k-anonymity and public breach catalogues. |
| [`agent-events`](agent-events) | Frozen `agent.*` event vocabulary for sandboxed runs. |
| [`session-observe`](session-observe) | Live observation of agent runs and single-holder control handoff. |
| [`rotation`](rotation) | Credential rotation state machine. |
| [`rotation-web`](rotation-web) | Web-login rotation: step IR and a tool boundary that never returns a credential. |
| [`ceremony`](ceremony) | Connector registration ceremonies: tier ladder and typed capture slots. |
| [`a2h`](a2h) | Agent-to-Human (A2H) v1.0 client; a human reply may only narrow authority. |
| [`task-bus`](task-bus) | CloudEvents-shaped bus with in-memory and NATS JetStream adapters. |

## Protocols and native

| Crate | Purpose |
|---|---|
| [`protocol-mcp`](protocol-mcp) | MCP Authorization bearer-profile adapter. |
| [`protocol-aauth`](protocol-aauth) | Experimental AAuth draft adapter (feature-gated, off by default). |
| [`authenticator-core`](authenticator-core) | Shared policy and OTP core for native authenticator providers. |

## Native roles

The libraries behind the roles of the one `opensesame` binary
([`apps/cli`](../apps/cli)). None of them builds an executable of its own.

| Crate | Purpose |
|---|---|
| [`gateway`](gateway) | The Host API, served by `opensesame host run`: routes, background actors, transports, signed provider callbacks. |
| [`daemon`](daemon) | The local host agent, served by `opensesame daemon run`. Its own dependency closure is budgeted ([ADR 0048](../docs/adr/0048-capability-moded-connector-discovery.md) §5, `pnpm audit:daemon-deps`). |
| [`worker`](worker) | The workload connector host, served by `opensesame worker run` ([ADR 0132](../docs/adr/0132-optional-mtls-and-workload-identity.md)). |
| [`credential-helpers`](credential-helpers) | git, Docker, AWS and kubectl credential helpers — `opensesame` answers as each under its link name ([ADR 0049](../docs/adr/0049-derived-short-lived-materialization.md)). |
| [`pm-bridges`](pm-bridges) | browserpass, gopass and keepassxc-protocol bridges, each a cargo feature of `opensesame`, all off by default ([ADR 0053](../docs/adr/0053-pm-bridge-binaries.md)). |

## Adding a crate

Create `crates/<name>/` with `name = "opensesame-<name>"`,
`version.workspace = true`, `edition.workspace = true` and
`license.workspace = true`, add it to `members` in the root
[`Cargo.toml`](../Cargo.toml), give it a one-line `description`, and list it in
the right table above.
