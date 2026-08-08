# Audit tick 47 — the PEP answered "allow" for everything it had no rule for

Date: 2026-08-08
Scanners: cve-lite, semgrep, clippy, gitleaks, ast-grep, cargo-audit, osv-scanner, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `ProvisionalPolicy.evaluate` — the module documented as "the PEP-facing contract" — returned `allow` for every request from a non-provisional principal, high-risk actions included. Its own `HIGH_RISK_ACTIONS` list (`organization.delete`, `grant.export_raw_credential`, `admin.impersonate`, `claim.force_complete`, …) only applied to provisional callers, and a test asserted the default-allow as intended behaviour. Any route that asked this policy about a dangerous action would have been told yes. | High-risk actions now deny for every subject with `high_risk_requires_explicit_authority`. Nothing in the system grants them today, so the honest answer is no. |
| Medium | Quotas only bound provisional principals, so a verified one could mint temporary projects and ephemeral agents without limit. | Verified principals are held to `DEFAULT_VERIFIED_QUOTA` (50 projects / 500 resources / 25 agents) — a larger allowance, not an absent one. |
| Medium | `evaluateDevicePoll` returned no error for a `consumed` device code, so a token endpoint that reads "no error" as "issue tokens" would mint a second set of tokens from one approval. | A consumed code answers `invalid_grant`; the device code is single use. |

## Notes

- The quota decision was refactored into one `quotaFieldFor` mapping so a new
  quota-bearing action cannot be added to the allowlist while silently skipping its limit.
- Provisional denial reason strings are unchanged (`provisional_quota_projects`), with
  the bare `quota_*` code added alongside, so existing callers keep matching.

## Follow-up

- Usage counters are cumulative and never decremented when a temporary project expires
  or an agent is removed, so the quota is a lifetime cap rather than a live one. A
  provisional principal is therefore permanently blocked after three temporary projects
  even once they lapse. Fixing it means counting live rows instead of a counter; tracked
  for a later tick.

## Verification

- `pnpm --filter @opensesame/policy test` — 6 passed (2 new)
- `pnpm --filter @opensesame/device-auth test` — 5 passed (1 new)
- `pnpm run typecheck`, `pnpm test` — clean
- semgrep, gitleaks, cve-lite, ast-grep, clippy, cargo-audit, osv-scanner, cargo-deny — clean
