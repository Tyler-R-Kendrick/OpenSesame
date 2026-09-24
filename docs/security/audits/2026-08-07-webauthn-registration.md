# Security audit — WebAuthn registration ceremony — 2026-08-07

Branch: `chore/audit-tick10`

## Scanners

| Check | Result |
|------|--------|
| osv / cargo-audit / deny / cve-lite / ast-grep / battle-test | CLEAN |
| Residual review | Passkey **register** accepted raw public keys without attestation/challenge in non-dev |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Production MFA passkey register trusted client-supplied `credentialId`/`publicKey` | Require `RegistrationResponseJSON` verified via SimpleWebAuthn against `/passkey/registration-options` challenge (`attestationType: direct`) |
| Process | Stale CI security-job docs (workflows removed in #26) | Left historical; local `pnpm audit:*` checklist remains |

## Gate

```bash
pnpm --filter @opensesame/auth-upstream build test
pnpm --filter @opensesame/control-plane test
```
