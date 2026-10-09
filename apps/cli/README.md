# opensesame-cli

The Host CLI, binary `opensesame`, on the Host/authority plane. It signs in to
the Host API, controls the local daemon, invokes connections by
`ConnectionRef`, manages certificates, tasks and lifecycle hooks, and carries
the `pass`-compatible sealed store. It is also the native host itself: `host
run`, `daemon run` and `worker run` serve the Host API, the local host agent
and the workload connector host, and the credential-helper and bridge names
are links to it (`helpers`). Agent-facing verbs never reveal a value; reading a
secret is an explicit, human-only verb.

## Where it fits

- **Used by:** people and scripts on the host. No workspace crate depends on it.
  Install and use: [skills/opensesame-clis](../../skills/opensesame-clis/SKILL.md).
- **Builds on:** [`gateway`](../../crates/gateway), [`daemon`](../../crates/daemon)
  and [`worker`](../../crates/worker) (the roles it serves),
  [`credential-helpers`](../../crates/credential-helpers) and
  [`pm-bridges`](../../crates/pm-bridges) (the helper names),
  [`sealed-store`](../../crates/sealed-store) and
  [`human-vault`](../../crates/human-vault) (`pass`), [`authn`](../../crates/authn)
  (login flows), [`connector-host`](../../crates/connector-host),
  [`storage`](../../crates/storage), [`ceremony`](../../crates/ceremony),
  [`env-spec`](../../crates/env-spec), [`kdbx-bridge`](../../crates/kdbx-bridge),
  [`provider-bitwarden`](../../crates/provider-bitwarden),
  [`vault-item-types`](../../crates/vault-item-types) (item extensions in `vault ls`),
  [`rotation-web`](../../crates/rotation-web), [`agent-hooks`](../../crates/agent-hooks),
  [`tailnet-admin`](../../crates/tailnet-admin) and
  [`plugin-settings`](../../crates/plugin-settings) (all `opensesame-*` crates).
- `invoke` takes a `ConnectionRef` (`conn://…`) or logical name, never a
  `SecretRef` ([ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)).
  `secret` and `lease` are human-only and never exposed through MCP or agent
  APIs.
- Every verb the capability registry assigns to the CLI must exist in the clap
  sources (`tests/capability_parity.rs`,
  [ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Surface

Global flags: `--server` (env `OPENSESAME_HOST_API`, default
`http://127.0.0.1:8787`), `--output` (default `json`).

With no arguments the binary runs the interactive session and the first-run
setup ceremony (`session`). Its verbs are grouped in three areas that mirror
the app's sections, `vault`, `access` and `identity`, beside the top-level
verbs below. The former top-level names of the area verbs still work: when the
first word is one of `pass`, `secret`, `sync`, `crypto`, `vault-inspect`,
`vault-migrate`, `lease`, `task`, `intent`, `local-authority`, `receipt`,
`connect`, `connection`, `connector`, `export`, `import`, `rotate`, `ceremony`,
`invoke`, `cert`, `lifecycle`, `status`, `whoami`, `auth` or `provider`, it is
rewritten to its path in the table (`src/session.rs`), so `opensesame pass show
…` runs `opensesame vault pass show …`.

| Path | Verbs |
|---|---|
| `vault` | `verify <file>`, `ls <file>`, `inspect`, `migrate`, `pass`, `secret`, `sync` (server-blind encrypted blobs), `crypto` |
| `vault pass` | `init`, `insert`, `generate`, `show`, `ls`, `find`, `rm`, `cp`, `mv`, `git`, `seal`, `import-kdbx`, `export-kdbx`, `backup`, `attach`, `otp`, `update`, `rotate`, `history`, `restore`, `protect`, `tomb`, `open`, `close` |
| `access grants` | `local-authority`, `lease`, `task`, `intent` |
| `access sessions` | `receipt verify` |
| `access connectors` | `connect`, `connection` (alias `connector`), `export`, `import`, `rotate` (sandboxed rotation runs), `ceremony` |
| `access resources` | `invoke`, `cert` (`ca`, `issue`, `ls`, `key`), `lifecycle` |
| `identity` | `status`, `whoami`, `auth doctor`, `providers` (`list`, `test`) |
| Session | `login` (device flow, terminal QR), `logout`, `doctor`, `session` |
| Project config | `init` (native `.env.schema`), `config`, `dev` (`check`, `resolve`, `run`: env-spec delivery), `config-files`, `tui` |
| Bridges | `bridge` (foreign password-manager clients, ADR 0053) |
| Roles | `host run`, `daemon run`, `worker run`; `helpers` (`link`) |
| Daemon control | `daemon` `install`, `start`, `status`, `logs`, `stop`, `info`, `approve-device`, `approve-claim`, `drive`, `fill`, `tailnet` |
| Security and governance | `security` (`findings`, `scan`, `check`), `hooks` (agent-hooks interceptor and Host policy), `plugins` (optional runtime plugins, ADR 0150), `password-agent` |
| Shell | `completion` |

`vault verify <file>` and `vault ls <file>` open an export or offline backup the
Pages PWA wrote, with the Rust reader ([`human-vault`](../../crates/human-vault)
`pages_vault`); the master password comes from a terminal only, and they print
names, kinds and paths, never values (parity with `opensesame-id vault`).

Source is one module per verb group under `src/` (`store.rs` and
`attach.rs` for `pass`, `connect.rs`, `certs.rs`, `sync_*.rs`,
`local_authority.rs`, and so on); `main.rs` holds the top-level clap tree and
`vault_area.rs`, `access_area.rs` and `identity_area.rs` the three areas.

## Develop

```bash
cargo +1.88.0 build -p opensesame-cli
cargo +1.88.0 test -p opensesame-cli
cargo +1.88.0 run -p opensesame-cli -- --help
cargo +1.88.0 run -p opensesame-cli -- pass --help
```

`tests/attach_journey.rs` and `tests/protect_rotation_journey.rs` drive the
real binary against a temporary store. `tests/vault_file_cli.rs` drives
`vault verify|ls` down its refusal paths (no terminal, no password flag or
variable, envelopes section 7 refuses); `src/vault_file_tests.rs` opens the
golden vectors in `spec/conformance/vault-vectors.json` through the same
reader. A new verb needs a
[`capability-registry`](../../packages/capability-registry) entry.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology, daemon control
- [ADR 0037](../../docs/adr/0037-git-sealed-store.md) — git-native sealed store
- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md), [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — KDBX and bridges
- [ADR 0054](../../docs/adr/0054-file-attachment-storage.md) — `pass attach`
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [Operators: local](../../docs/operators/local.md), [architecture: host/client topology](../../docs/architecture/host-client-topology.md)
