# opensesame-connection-detect

Value-blind detection of provider credentials already configured on a machine.
Two callers share it: the Host broker, which turns a detection into a sealed
connection, and the local daemon, which only ever *reports* that something looks
configured. A detection names where a credential was seen — an environment
variable, a file path, an MCP server, a keychain label — and never a value, a
prefix or a length. Nothing here opens a network connection, touches a database
or seals a credential.

## Where it fits

- **Used by:** [`apps/daemon`](../../apps/daemon) (discovery, keychain and CLI
  probes, the promote handshake), [`opensesame-connection-broker`](../connection-broker)
  (`config.rs` reads provider fields through the same aliases), and the fuzz
  harness in [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`ini_parse`,
  `mcp_config`, `promote_request`).
- **Builds on:** no workspace crates. The whole dependency tree is `serde`,
  `serde_json`, `thiserror` and std — the budget ADR 0048 §5 sets for code that
  ships onto a loopback agent. `pnpm audit:daemon-deps` fails if the tree grows.
- Environment, filesystem, keychain and command access are injected by the
  caller, so a scan runs the same against a real process, another process's
  environment or a fixture. Probes have no socket, HTTP client or URL anywhere
  in their API.
- Results are phrased as "these look configured", never "these are connected".

## Surface

| Area | Main items |
|---|---|
| Host scan (ADR 0047) | `scan(read_env, read_file)` → `Vec<Detection>`; `Detection`, `Source`, `SourceKind` (`Env`, `File`, `Mcp`) |
| Aliases and file readers | `ALIASES`, `GENERIC_API_KEY_PROVIDERS`, `env_aliases`, `env_var_name` (`OPENSESAME_PROVIDER_<ID>_<FIELD>`), `detected_file_value`, `detected_gcp_file`, `detected_aws_file_value`, `ini_value`, `mcp_server_names`, `mcp_server_env_keys` |
| Offers (`offers`, ADR 0048) | `CapabilityClass` (`Importable`, `InvokeThrough`, `Mintable`), `OfferItem`, `ProbeReport`, `ProbeContext`, `CapabilityProbe`, `KeychainBackend`, `CommandRunner`, `EnvDotfileProbe`, `merge_offers`, `build_report`, `mint_capable`; `OFFER_SCHEMA_VERSION` = 1 |
| Promote (`promote`, ADR 0048 D4) | `PromoteRequest`, `PromotionMode` — the `POST /v1/promote` body; `deny_unknown_fields` is part of the contract |

## Develop

```bash
cargo +1.88.0 test -p opensesame-connection-detect
pnpm audit:daemon-deps   # pins this crate's dependency closure
```

Adding a dependency here means updating the allowlist in
[`scripts/audit/daemon-deps-gate.sh`](../../scripts/audit/daemon-deps-gate.sh),
which is a budget decision under ADR 0048 §5.

## Related

- [ADR 0047](../../docs/adr/0047-daemon-connector-discovery.md) — daemon
  connector discovery
- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) —
  capability-moded discovery and the daemon dependency budget
- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) —
  password-manager bridging
