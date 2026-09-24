# Security audit — mock upstream IdP PKCE S256 — 2026-08-07

Branch: `chore/audit-tick22`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / cargo-audit | CLEAN |
| Residual review | Mock IdP advertised `plain` PKCE and never checked `code_verifier` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | `/authorize` + `/token` ignored PKCE; discovery listed `plain` | Require `code_challenge_method=S256`; verify SHA-256(`code_verifier`) on token exchange (timing-safe) |

## Gate

```bash
pnpm --filter @opensesame/mock-upstream-idp test
```
