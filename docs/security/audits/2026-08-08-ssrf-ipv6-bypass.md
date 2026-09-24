# Security audit — metadata SSRF denylist IPv6 bypass — 2026-08-08

Branch: `chore/audit-tick29`

## Scanners

| Check | Result |
|------|--------|
| osv-scanner / cargo-audit / cargo-deny | CLEAN |
| Residual review | `assertSafeMetadataUrl` only recognised the dotted `::ffff:a.b.c.d` spelling |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High (gated) | WHATWG URL canonicalizes `http://[::ffff:127.0.0.1]` to `::ffff:7f00:1`, and the hex spelling skipped the IPv4 checks — loopback, RFC1918, and `169.254.169.254` were all reachable through IPv4-mapped/IPv4-compatible IPv6 literals | Expand IPv6 to 8 hextets, extract the embedded IPv4 from `::ffff:0:0/96` and `::/96`, and apply the IPv4 rules |
| Medium | IPv6 prefix checks were string-prefix based, so `fc00::/7` / `fe80::/10` edges were partially missed and multicast was allowed | Bitmask checks for `fc00::/7`, `fe80::/10`, `ff00::/8`; unparseable IPv6 now fails closed |
| Low | IPv4 list omitted multicast/reserved, `192.0.0.0/24`, `198.18.0.0/15` | Added; `a >= 224` covers multicast, reserved, and broadcast |

Reachability is limited: the fetcher is off unless `OPENSESAME_CIMD_ENABLED` is set
and redirects are already `redirect: "error"`. Decimal/octal IPv4 (`2130706433`,
`0177.0.0.1`) was already safe via URL canonicalization — now covered by tests.
DNS rebinding remains out of scope for a pre-resolution denylist.

## Gate

```bash
pnpm --filter @opensesame/oauth-provider test
pnpm --filter @opensesame/oauth-provider typecheck
pnpm --filter @opensesame/control-plane test
```
