# opensesame-cli

The Host CLI, binary `opensesame`, on the Host/authority plane. It signs in to
the Host API, installs and controls the local daemon, invokes connections by
`ConnectionRef`, manages certificates, tasks and lifecycle hooks, and carries
the `pass`-compatible sealed store. Agent-facing verbs never reveal a value;
reading a secret is an explicit, human-only verb.

## Where it fits

- **Used by:** people and scripts on the host. No workspace crate depends on it.
  Install and use: [skills/opensesame-clis](../../skills/opensesame-clis/SKILL.md).
- **Builds on:** [`sealed-store`](../../crates/sealed-store) and
  [`human-vault`](../../crates/human-vault) (`pass`), [`authn`](../../crates/authn)
  (login flows), [`connector-host`](../../crates/connector-host),
  [`storage`](../../crates/storage), [`ceremony`](../../crates/ceremony),
  [`env-spec`](../../crates/env-spec), [`kdbx-bridge`](../../crates/kdbx-bridge),
  [`provider-bitwarden`](../../crates/provider-bitwarden) and
  [`pm-bridges`](../pm-bridges) (all `opensesame-*` crates).
- `invoke` takes a `ConnectionRef` (`conn://…`) or logical name, never a
  `SecretRef` ([ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)).
  `secret` and `lease` are human-only and never exposed through MCP or agent
  APIs.
- Every verb the capability registry assigns to the CLI must exist in the clap
  sources (`tests/capability_parity.rs`,
  [ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Surface

Global flags: `--server` (env `OPENSESAME_SERVER`, default
`http://127.0.0.1:8787`), `--output` (default `json`).

| Group | Verbs |
|---|---|
| Session | `login` (device flow, terminal QR), `logout`, `status`, `whoami`, `auth`, `doctor` |
| Authority | `invoke`, `receipt`, `task`, `intent`, `local-authority` |
| Connections | `provider`, `connect`, `connection` (alias `connector`), `export`, `import`, `config-files`, `tui` |
| Human-only reads | `secret`, `lease`, `crypto` |
| Sync | `sync` (server-blind encrypted blobs) |
| Project config | `init` (native `.env.schema`), `config`, `dev` (env-spec delivery) |
| Sealed store | `pass`: `init`, `insert`, `generate`, `show`, `ls`, `find`, `rm`, `cp`, `mv`, `git`, `seal`, `import-kdbx`, `export-kdbx`, `backup`, `attach`, `otp`, `update`, `rotate`, `history`, `restore`, `protect`, `tomb`, `open`, `close` |
| Bridges | `bridge` (foreign password-manager clients, ADR 0053) |
| Daemon | `daemon install`, `start`, `status`, `logs`, `stop` |
| Lifecycle and security | `lifecycle`, `rotate`, `ceremony`, `cert`, `security` |
| Vault KDF | `vault-inspect`, `vault-migrate` |
| Shell | `completion` |

Source is one module per verb group under `src/` (`store.rs` and
`attach.rs` for `pass`, `connect.rs`, `certs.rs`, `sync_*.rs`,
`local_authority.rs`, and so on); `main.rs` holds the clap tree.

## Develop

```bash
cargo +1.88.0 build -p opensesame-cli
cargo +1.88.0 test -p opensesame-cli
cargo +1.88.0 run -p opensesame-cli -- --help
cargo +1.88.0 run -p opensesame-cli -- pass --help
```

`tests/attach_journey.rs` and `tests/protect_rotation_journey.rs` drive the
real binary against a temporary store. A new verb needs a
[`capability-registry`](../../packages/capability-registry) entry.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology, daemon control
- [ADR 0037](../../docs/adr/0037-git-sealed-store.md) — git-native sealed store
- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md), [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — KDBX and bridges
- [ADR 0054](../../docs/adr/0054-file-attachment-storage.md) — `pass attach`
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [Operators: local](../../docs/operators/local.md), [architecture: host/client topology](../../docs/architecture/host-client-topology.md)
