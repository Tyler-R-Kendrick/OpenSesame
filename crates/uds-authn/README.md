# opensesame-uds-authn

Peer-credential attestation for callers of the local host daemon over a Unix
domain socket. Loopback TCP is not a boundary, so the daemon's operator routes
need a bearer token there; over a Unix socket the kernel attests which process
is on the other end. This crate reads that attestation and applies a same-user
allowlist.

## Where it fits

- **Used by:** [`apps/daemon`](../../apps/daemon) (operator routes over the
  socket, agent capabilities, invoke-through).
- **Builds on:** no workspace crates (`thiserror`; `nix` on Unix).
- Fail-closed everywhere: a lookup error, an empty allowlist or a foreign UID
  denies. An all-malformed allowlist parses to empty, which denies.
- Only `authorize` and `parse_allowed_uids` are portable; credential extraction
  is Unix-only and `cfg`-gated.

## Surface

| Item | Role |
|---|---|
| `peer_cred(&stream) -> Result<PeerCred, AuthnError>` | `SO_PEERCRED` on Linux and Android, `LOCAL_PEERCRED` + `LOCAL_PEERPID` on macOS, `Unsupported` elsewhere |
| `PeerCred` | `pid`, `uid`, `gid` |
| `authorize(&PeerCred, allowed_uids)` | Passes only a UID in the list |
| `default_allowed_uids()` | The daemon's own effective UID (empty on non-Unix) |
| `parse_allowed_uids(csv)` | Parses `OPENSESAME_DAEMON_ALLOWED_UIDS`; malformed entries are dropped |
| `AuthnError` | `Lookup`, `Unsupported`, `ForeignUid`, `EmptyAllowlist` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-uds-authn
pnpm audit:daemon-deps
```

## Related

- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — capability-moded discovery; the crate cites §8 (platform identity over a presented secret)
- [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — the daemon dependency gate covers this crate's full tree
- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS; single-host loopback and Unix sockets stay protected by this crate and the operator token
- [`opensesame-tailscale-authn`](../tailscale-authn) — the tailnet counterpart
