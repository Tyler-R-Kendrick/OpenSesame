# crates/

Rust libraries for the **Host / authority plane** (and `client-core`, the Client
plane's SDK). Every crate here is a member of the root Cargo workspace, has the
package name `opensesame-<directory>`, and builds with the pinned Rust 1.88
toolchain. The `opensesame` binary that links them lives in
[`apps/cli`](../apps/README.md); two crates also ship a binary of their own,
`nats-callout` (`opensesame-nats-auth-bridge`) and `surrogate-proxy` (the optional
plugin `opensesame-surrogate-proxy`).

```bash
cargo +1.88.0 test -p opensesame-sealed-store      # one crate
cargo +1.88.0 test --workspace --all-targets       # everything (CI scopes it to the crates a diff reaches)
pnpm audit:clippy                                  # rustfmt + pedantic Clippy
```

Complexity limits come from [`clippy.toml`](../clippy.toml) and match the
TypeScript ones; files stay under 400 lines. `pnpm quality:packages` fails on a
dependency cycle between crates.

## SDK facades

What an application links against. `core`, `host-core` and `client-core`
re-export the libraries below them behind a stable surface
([ADR 0017](../docs/adr/0017-host-client-product-topology.md)); `domain` and
`connector-sdk` are the layers they sit on and beside.

| Crate | Purpose |
|---|---|
| [`core`](core) | Shared IR with no I/O: the domain model and `AuthorityHandle`, per the `core` WIT world. |
| [`host-core`](host-core) | Host logic facade: re-exports the broker, authorization, authn, audit, connector host and env-spec crates; adds the endpoint table, bind and deployment-mode policy, the operator check and CORS hardening. |
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
| [`surrogate-proxy`](surrogate-proxy) | Per-run proxy where an unmodified client holds a surrogate and invoke-through places the credential ([ADR 0150](../docs/adr/0150-surrogate-credentials-at-the-last-hop.md)); ships only as the optional plugin binary `opensesame-surrogate-proxy`. |
| [`plugin-settings`](plugin-settings) | The optional-plugin catalog, the settings file that switches plugins, and install pins verified at every launch ([plugins guide](../docs/operators/plugins.md)). |
| [`provider-openbao`](provider-openbao) | OpenBao credential-authority adapter. |
| [`provider-openfga`](provider-openfga) | OpenFGA remote PDP client. |
| [`provider-bitwarden`](provider-bitwarden) | Bitwarden / Vaultwarden consume-client ([ADR 0052](../docs/adr/0052-password-manager-ecosystem-bridging.md)). |
| [`bitwarden-server`](bitwarden-server) | Bitwarden-compatible server: Bitwarden clients against the Host, Argon2id, a replaceable server hash ([ADR 0141](../docs/adr/0141-bitwarden-compatible-server.md)); the gateway's optional `bitwarden-compat` bridge feature ([ADR 0148](../docs/adr/0148-bitwarden-bridge-and-importer.md)). |
| [`provider-static-mesh`](provider-static-mesh) | Static service discovery for tests and Headscale-style deployments. |
| [`collab-adapter`](collab-adapter) | Projects an authority onto a collaboration platform's roles (Discord, bot token only). |
| [`dns-enforcement`](dns-enforcement) | DNS-layer enforcement through Blocky, with an honest statement of its coverage. |

## Storage and vaults

| Crate | Purpose |
|---|---|
| [`storage`](storage) | The Host database (SQLite via SQLx); one module per responsibility, migrations in [`migrations/`](storage/migrations). |
| [`human-vault`](human-vault) | Server-blind E2EE envelopes shared by the vault and the sealed store. |
| [`sealed-store`](sealed-store) | Git-native hierarchical sealed store with `pass` parity, attachments and tombs. |
| [`vault-item-types`](vault-item-types) | Item-type parser and registry; embeds the definitions in [`marketplace/item-types/builtin`](../marketplace/item-types/builtin) except the five credential types. |
| [`kdbx-bridge`](kdbx-bridge) | KeePass KDBX 4 read/write mapped onto the sealed store. |
| [`env-spec`](env-spec) | Consumes `.env.schema` JSON to resolve developer environments without printing values. |
| [`event-seal`](event-seal) | Seals the Host's event and audit rows at rest under a key derived from the Host sealing key: one process-wide sealer ([ADR 0157](../docs/adr/0157-logs-and-events-carry-no-secrets.md)). |
| [`sealed-log`](sealed-log) | An encrypted, rotating log file: every line sealed on its own under a key kept apart from it ([ADR 0157](../docs/adr/0157-logs-and-events-carry-no-secrets.md)). |

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
| [`tailnet-admin`](tailnet-admin) | Tailnet device management for the daemon: the Tailscale credential, origin-bound role pairings, the upstream client and the audit trail ([ADR 0169](../docs/adr/0169-tailnet-device-management.md)). |

## Lifecycle, events and rotation

| Crate | Purpose |
|---|---|
| [`lifecycle`](lifecycle) | Expiry ladder, `lifecycle.*` hook events and authority-invalidation fencing, as pure functions — deadlines are detected once, by the gateway's scanner, and published on this feed ([ADR 0074](../docs/adr/0074-expiry-lifecycle-hooks.md)). |
| [`security-events`](security-events) | The shared `SecurityNotice` envelope and its Alertmanager, PagerDuty and syslog renderings ([ADR 0080](../docs/adr/0080-security-event-hooks.md)). |
| [`breach-intel`](breach-intel) | Value-blind breach detection: Pwned Passwords k-anonymity and public breach catalogues. |
| [`agent-events`](agent-events) | Frozen `agent.*` event vocabulary for sandboxed runs. |
| [`agent-hooks`](agent-hooks) | OpenSesame as an agent-hooks/0.1 interceptor: tool rules, result labels, a value-blind secret guard, digest-bound approvals and the Interaction-backed approver that puts an escalation to a person ([ADR 0159](../docs/adr/0159-agent-hooks-interceptor.md)). |
| [`session-observe`](session-observe) | Live observation of agent runs and single-holder control handoff; a run lease revokes its credentials when it parks or ends. |
| [`rotation`](rotation) | Credential rotation state machine. |
| [`rotation-web`](rotation-web) | Web-login rotation: step IR, a tool boundary that never returns a credential, the agent-hooks/0.1 host for its runs (authority pinned, no lock across an approval) and the signed recipe document ([ADR 0159](../docs/adr/0159-agent-hooks-interceptor.md)). |
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
| [`daemon`](daemon) | The local host agent, served by `opensesame daemon run`. Its direct dependencies are budgeted ([ADR 0048](../docs/adr/0048-capability-moded-connector-discovery.md) §5, `pnpm audit:daemon-deps`). |
| [`worker`](worker) | The workload connector host, served by `opensesame worker run` ([ADR 0132](../docs/adr/0132-optional-mtls-and-workload-identity.md)). |
| [`credential-helpers`](credential-helpers) | git, Docker, AWS and kubectl credential helpers — `opensesame` answers as each under its link name ([ADR 0049](../docs/adr/0049-derived-short-lived-materialization.md)). |
| [`pm-bridges`](pm-bridges) | browserpass, gopass and keepassxc-protocol bridges, each a cargo feature of `opensesame`, all off by default ([ADR 0053](../docs/adr/0053-pm-bridge-binaries.md)). |

## Adding a crate

Create `crates/<name>/` with `name = "opensesame-<name>"`,
`version.workspace = true`, `edition.workspace = true` and
`license.workspace = true`, add it to `members` in the root
[`Cargo.toml`](../Cargo.toml), give it a one-line `description`, and list it in
the right table above.
