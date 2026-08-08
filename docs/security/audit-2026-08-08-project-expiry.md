# Audit tick 53 — temporary projects that never ran out

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The cleanup worker only expired projects in state `provisional`, so a temporary project that reached `active` — the normal outcome of a completed claim — outlived its own `expiresAt` indefinitely. The TTL a caller was promised was enforced for unclaimed projects and ignored for claimed ones. | Both `provisional` and `active` projects expire once `expiresAt` passes, matching `maybeExpireProvisionalResource` in the domain machine. |
| Medium | Claim completion promoted a project to `active` without checking whether the project had already lapsed, so approval could hand back a project past its TTL that nothing would expire again. | Completion marks a lapsed project `expired` instead of activating it. Reachable only if the claim ever outlives the project — today the claim TTL is derived from it — so this is a guard against the coupling changing, and is tested directly. |
| Low | Expired projects were never removed from the store, so a long-lived process accumulated every temporary project it had ever issued. | Expired and deleted projects are dropped after a one-hour retention window (`reapedProjects` in the tick result). |
| Medium | `sealDevOnly`'s production guard asked `process.env.NODE_ENV === "production"`. A browser bundle has no `process.env`, so the check answered "not production" in exactly the environment it ships to, and the deprecated XOR would have run there. | The question is inverted: the seal refuses unless it can prove it is a dev or test run (`NODE_ENV` of `development`/`test`, or an explicit `__OPENSESAME_ALLOW_DEV_SEAL__` opt-in). An empty key is also refused. |

## Notes

- `sealDevOnly` has no callers today; the fix is to stop the trap being armed for the
  next caller, since the failure mode is silent (XOR "encryption" that looks fine).
- The standalone worker is still constructed with empty session/project maps, so in
  that deployment shape it expires nothing. Sharing state (or moving expiry behind
  the repositories) is a design change, tracked rather than patched here.

## Verification

- `pnpm --filter @opensesame/worker test` — 3 passed (1 new: active project expires,
  then is reaped after the retention window)
- `pnpm --filter @opensesame/control-plane test` — 31 passed (1 new: lapsed project is
  not activated by approval)
- `pnpm --filter @opensesame/client-core test` — 4 passed (guard covers the
  no-`NODE_ENV` browser case)
- `pnpm run typecheck`, `pnpm test` — clean
- semgrep, gitleaks, cargo-audit, cargo-deny, osv-scanner, cve-lite, ast-grep — clean
