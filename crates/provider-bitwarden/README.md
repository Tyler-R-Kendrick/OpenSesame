# opensesame-provider-bitwarden

A native Bitwarden / Vaultwarden consume-client. A person's Bitwarden account or
self-hosted vaultwarden becomes an upstream credential source that OpenSesame
reads directly, in place of shelling out to the `bw` CLI: no Node.js runtime, no
`BW_SESSION` variable, and no unlocked key outside the process that asked for
it. It belongs to the human plane only.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`src/providers_native.rs`, the
  `bitwarden` / `vaultwarden` providers) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`bitwarden_encstring`).
- **Builds on:** no workspace crates. `reqwest`, `argon2`, `pbkdf2`, `hkdf`,
  `aes`/`cbc`, `secrecy`, `zeroize`.
- Nothing here is reachable from an agent surface: no MCP tool, no WIT import,
  no `ConnectionRef` invoke path. The master password is prompted on a TTY by
  `apps/cli`, held in a `SecretString`, and never written to disk, argv or the
  environment. The unlocked `Session` is in memory and TTL-bound.
- Egress mirrors [`opensesame-invoke-through`](../invoke-through) in-crate: the
  configured host is pinned, https is required (loopback http only for tests),
  and redirects are refused rather than followed.
- [`apps/daemon`](../../apps/daemon) does not and must not depend on it;
  `pnpm audit:daemon-deps` is the alarm.
- The protocol and crypto are implemented from the public format description,
  informed by rbw (MIT); see [`NOTICE`](NOTICE). No AGPL/GPL source is copied.

## Surface

| Item | Role |
|---|---|
| `Config` (`from_server_url`, `from_split_urls`, `with_device`, `with_session_ttl`) | Where the vault lives and how long a session lasts |
| `BitwardenClient::unlock` | Prelogin, KDF, login and key unwrap into a `Session` |
| `BitwardenClient::read`, `list`, `vault`, `server_config` | Read one item's secret, list names, sync the decrypted vault |
| `api` (`Client`, `Endpoints`, `SyncResponse`, `DeviceIdentity`) | The HTTP API client |
| `crypto`, `kdf` | EncString parsing, key derivation within a policy range |
| `vault` (`Vault`, `Item`, `ItemKind`, `Login`, `Folder`, `UnreadableItem`, …) | The decrypted model |
| `Session`, `DEFAULT_SESSION_TTL`, `Error` | In-memory session and the error type |

## Develop

```bash
cargo +1.88.0 test -p opensesame-provider-bitwarden
```

Tests run against a loopback stub with recorded cloud and vaultwarden fixtures
([`tests/fixtures`](tests/fixtures)) and crypto vectors
([`tests/vectors`](tests/vectors)). The fixture and vector regenerators and
the production-KDF test are `#[ignore]`d. `tests/session_discipline.rs` checks
mechanically that key types implement neither `Debug` nor `Serialize`.

## Related

- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) — password-manager ecosystem bridging
- [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — PM bridge binaries
- [`docs/architecture/pm-bridges.md`](../../docs/architecture/pm-bridges.md)
