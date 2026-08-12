# Audit tick 46 — three fences that compared prefixes instead of parsing

Date: 2026-08-08
Scanners: cargo-audit, osv-scanner, cve-lite, semgrep, security battle test, clippy, gitleaks, cargo-deny, ast-grep

Each of these accepted a value that merely *started with* the trusted string.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `validate_verification_uri_complete` (device flow) accepted any `verification_uri_complete` that began with the issuer origin, so `https://issuer.example.evil.test/device?user_code=…` passed. That URL is opened in the human's browser to approve a device login — a working device-code phish, delivered by the client's own safety check. | Parse both URLs and require scheme, host, and port to match, reject embedded credentials, and confine a path-scoped issuer to its own subtree. |
| Medium | `EgressBinding::allows_url` matched path prefixes with a bare `starts_with`, so a grant attenuated to `/repos/acme` also authorized `/repos/acme-private/secrets`. | Require an exact match or a `/` segment boundary. |
| Medium | `is_blocked_host` (connector host) matched private ranges as strings: `2130706433`, `0x7f000001`, `017700000001`, and `::ffff:127.0.0.1` are all 127.0.0.1 and none started with `127.`, while `172.16/12` was only partially covered by hand-rolled octet parsing. The same code blocked `fcbank.example.com` for starting with `fc`. | Parse the host as an IP — including the integer, hex, octal, and IPv4-mapped spellings resolvers accept — and range-check it; names are left to the egress allowlist. |

## Notes

- The egress allowlist is still the primary destination fence, so the host check is
  defense in depth; that is exactly why it should not have been the one with holes.
- IPv4-mapped and IPv4-compatible IPv6 are judged by their embedded v4 address, matching
  the fix made for the TypeScript metadata fetcher in tick 29. Both now cover
  loopback, private, link-local, CGNAT, benchmarking, documentation, multicast, and
  reserved ranges.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (5 new tests across authn, domain, connector-host)
- semgrep, gitleaks, cargo-audit, osv-scanner, cargo-deny, cve-lite, ast-grep — clean
