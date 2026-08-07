# Security audit loop — 2026-08-07

Branch: `chore/security-audit-loop`

## Scanners (each pass)

| Tool | Result |
|------|--------|
| gitleaks | Clean |
| cargo-deny | Clean |
| pnpm audit | Clean |
| Semgrep | 0 findings |
| Dependabot open | 0 |

## Findings fixed this loop

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Sync push could overwrite another session's blob / steal ownership | Reject blobs whose owner session ≠ caller (`rejected_foreign_owner`) |
| Medium | Claim token hash compared with `!=` (timing) | `hash_eq` constant-time digest compare |
| Medium | Unauthenticated claim deny by any principal | Deny requires `creatorPrincipalId ===` caller |
| Medium | MCP `list_connections` / `invoke_l1` / `whoami` omitted session token | Require `OPENSESAME_ACCESS_TOKEN` |
| Medium | Daemon `toolbar/status` unauthenticated | Operator token required |
| Medium | Unbounded agent-claim / device-code maps (DoS) | Evict expired + capacity caps (256 / 512) |
| Low | Identity device proxy accepted credentialed / non-http URLs | Scheme + userinfo validation |
| Low | `live-stack-test.sh` wrote `.cursor/debug-7aa2f5.log` | Removed |

## Stop condition

Pass-3 checklist after fixes reported **CLEAN** for known auth/antipattern classes; scanners remain green. Remaining intentional public surfaces: OAuth device authorize/token, discovery docs, health, agent-identity create (capacity-capped), claim present/poll by design.
