# opensesame-tailscale-authn

Tailnet caller identity for the local host daemon. When the daemon is reached
over Tailscale, a caller proves nothing by presenting a token; the tailnet has
already authenticated the machine. This crate asks the local `tailscaled` who a
remote address is (`GET /localapi/v0/whois?addr=ip:port` over its Unix socket)
and authorizes the answer against an explicit user and tag allowlist.

## Where it fits

- **Used by:** [`crates/daemon`](../../crates/daemon), only when built with
  `--features tailscale`, for its read-only tailnet listener; and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`whois_response`).
- **Builds on:** no workspace crates (`serde`, `serde_json`, `thiserror`).
- The transport is std-only: one GET over a Unix socket does not justify an
  HTTP framework in the daemon's dependency budget. The response is capped at
  64 KiB, parsed, and never followed anywhere.
- Every failure denies: socket absent, non-200, malformed body, or empty
  allowlists.

## Surface

| Item | Role |
|---|---|
| `whois(addr)`, `whois_via(socket_path, addr, timeout)` | Ask `tailscaled`; Unix only (`Unsupported` elsewhere) |
| `WhoisIdentity` | `node_name`, `tags`, `login_name`; `key()` for rate-limit keying |
| `authorize(identity, allowed_users, allowed_tags) -> bool` | Passes on an allowed login name or any allowed tag; empty lists deny everyone |
| `parse_csv` | Reads `OPENSESAME_TAILSCALE_ALLOW_USERS` / `OPENSESAME_TAILSCALE_ALLOW_TAGS` values |
| `parse_response` | Bounded parse of a whois body |
| `DEFAULT_SOCKET_PATH`, `MAX_RESPONSE_BYTES` | `/var/run/tailscale/tailscaled.sock`, 64 KiB |
| `AuthnError` | `Socket`, `Io`, `Status`, `TooLarge`, `Malformed`, `Unsupported` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-tailscale-authn
cargo +1.88.0 build -p opensesame-cli --features tailscale
pnpm audit:daemon-deps
```

## Related

- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — capability-moded discovery; decision 8, tailnet identity authorizes daemon callers
- [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — PM bridge binaries; the daemon dependency gate covers this crate's full tree
- [`opensesame-uds-authn`](../uds-authn) — the Unix-socket counterpart
