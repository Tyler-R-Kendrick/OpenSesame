# Audit — SSRF host parsing (2026-08-08)

Tick 55. Scope: the destination fences — `crates/connector-host`
(`is_blocked_host`, the fence in front of every host-mediated egress),
`packages/oauth-provider/src/metadata/safe-fetcher.ts` (CIMD metadata fetch),
plus the loopback checks in `apps/mcp-host/src/host-api.ts` and
`crates/host-core`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `is_blocked_host("::1")` returned false. `Ipv6Addr::to_ipv4` reads `::1` as the routable `0.0.0.1`, and the early return on that view shadowed the `is_loopback` check below it, so `https://[::1]/` passed the fence. | The v6 rules are evaluated first; the embedded v4 view is an additional check, not a substitute. |
| High | Short `inet_aton` spellings were not read as addresses: `127.1`, `10.1`, `0177.0.0.1`, `0x7f.1` all resolve to private addresses through `getaddrinfo`, and each fell through to "a name we cannot resolve here". | `parse_inet_aton` accepts one to four parts, each decimal, octal or hex, with the last absorbing the remaining bytes — matching what resolvers accept. Out-of-range parts are refused rather than wrapped. |
| Medium | A zone id defeated parsing: `fe80::1%eth0` was not link-local as far as the fence was concerned. | The zone id is stripped before parsing. |
| Medium | A trailing dot defeated both the name and address checks: `localhost.` and `127.0.0.1.` resolve normally. | The DNS root dot is stripped. |
| Medium | NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) wrap an IPv4 destination the network unwraps; neither fence looked inside. Present in both the Rust fence and the TypeScript metadata fetcher. | `embedded_v4` / `embeddedIpv4` extract the wrapped address and judge it. |

## Not findings

- `apps/mcp-host/src/host-api.ts` and `crates/host-core` check loopback as a
  strict allowlist, so unrecognized spellings fail closed. `127.1` is refused
  there rather than accepted — the safe direction for an allowlist.
- The TypeScript metadata fetcher runs its checks on the WHATWG-canonical host,
  which already folds `127.1` and `2130706433` into dotted quads. Only the
  NAT64/6to4 wrappers were missing.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `pnpm test`, `pnpm run typecheck`, task-security-battle-test,
semgrep, ast-grep, osv-scanner, gitleaks, cve-lite, cargo-audit, cargo-deny —
all clean.
