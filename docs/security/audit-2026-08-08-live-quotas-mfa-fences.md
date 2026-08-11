# Audit tick 48 — lifetime quotas, unfenced MFA verification

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Quota usage was a running counter that only ever went up, so the provisional cap was a lifetime cap: three temporary projects and the principal was blocked forever, even after all three had lapsed. Legitimate users lock themselves out, and the natural workaround is a second anonymous principal — which defeats the quota it was meant to enforce. | `getUsage` counts live projects and agents from the stores (owner match, live state, not past `expiresAt`), so an expired project returns its slot. The counter survives only for temporary resources, which have no store to count. |
| Medium | `POST /v1/mfa/totp/verify` had no attempt fence, so a six-digit code was 10^6 guesses at whatever rate the caller managed. `POST /v1/mfa/passkey/assert` was likewise unlimited and unauthenticated. | Five failures per subject (`totp:<principal>`, `passkey:<credentialId>`) then 429; a success clears the count. |
| Medium | `createMemoryChallengeStore` never pruned: every issued WebAuthn challenge stayed in memory whether or not it came back, so an authenticated loop over `/passkey/authentication-options` grew the map without limit. | Expired rows are dropped on each write and the store caps at 4096 outstanding challenges, evicting the oldest. |

## Notes

- Live counting deliberately treats `suspended` agents and `provisional`/`active`
  projects as occupying a slot; only expiry, deletion, or revocation frees one.
- The TOTP fence closes even against the correct code — a locked fence that a correct
  guess reopens is not a fence. It is per-principal and in-memory, matching the
  claim-approval fence from tick 41.

## Verification

- `pnpm --filter @opensesame/control-plane test` — 30 passed (3 new)
- `pnpm --filter @opensesame/auth-upstream test` — 12 passed (1 new)
- `pnpm run typecheck`, `pnpm test`, `cargo test --workspace`, clippy — clean
- cargo-audit, osv-scanner, cargo-deny, semgrep, gitleaks, cve-lite, ast-grep — clean
