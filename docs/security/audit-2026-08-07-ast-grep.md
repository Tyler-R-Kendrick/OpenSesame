# Security audit — ast-grep loop — 2026-08-07

Branch: `chore/security-ast-grep-loop`

Tool: **ast-grep** (structural SAST). Not used in prior loops (gitleaks, cargo-deny, pnpm audit, Semgrep, cve-lite).

## Scanners

| Check | Result |
|------|--------|
| `pnpm run audit:ast-grep` | CLEAN |
| Rules | `security/ast-grep-rules.yml` (SQL format, shell -c, Math.random, eval, innerHTML, localStorage, exec) |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | DPoP `jti` fell back to `Math.random()` when `randomUUID` missing | `randomJti()` via `randomUUID` / `getRandomValues` only |
| Medium | Sealed sync persisted to `localStorage` (XSS-exfiltrable) | OPFS primary; in-memory `Map` fallback — never web storage |
| Low | OpenBao `use_credential` Result ignored (`let _ =`) | Log warn on failure |
| Build | Accidental `const mut store` in sync_push | Restored `let mut store` |

## Gate

```bash
pnpm run audit:ast-grep
```
