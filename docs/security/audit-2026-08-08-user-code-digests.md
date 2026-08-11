# Audit — user code digests (2026-08-08)

Tick 54. Scope: the claim consent path — `packages/claims` (TypeScript engine),
`packages/os-domain/src/crypto/claim-token.ts`, `crates/claims`, and the Host
routes that mint and check user codes.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Host stored user codes as `sha256(code)` with no key and no salt. A user code is 8 characters from a 20-letter alphabet (~2^35), a space that is exhausted quickly, so the digest was close to the code itself for anyone who read state. | `hash_low_entropy(pepper, context, code)` — HMAC-SHA-256 keyed by `OPENSESAME_CLAIM_PEPPER`, with purpose, context and code length-prefixed. Used for both device-flow and agent-claim user codes. |
| Medium | Every claim's `userCodeDigest` was HMAC'd under the same fixed `"user-code"` label, so one precomputation over the ~40-bit code space covered every claim ever issued. | `digestUserCode`/`verifyUserCode` now take the claim id and bind it into the digest; each claim is its own search. `digestDeviceCode` binds the session id the same way. |
| Medium | Host digests were compared globally, so a user code recovered from one device code or claim was equally good against every other. | Digests are bound to the device-code digest / claim id. Device approve recomputes per candidate entry (bounded at 512 pending). |
| Low | `ClaimEngine.completeClaim` re-entered itself on a lost review CAS with no bound, so concurrent completers could recurse until the stack gave out. | Attempt counter bounded at 8, matching `applyTransition`, then `CONFLICT`. |
| Low | `loadFresh` returned `won ? session : session`. | Collapsed — the store's version is authoritative either way. |

## Notes

- Existing user-code digests do not verify after this change. Claims and device
  codes live 10–15 minutes, so the window is a restart, not a migration.
- `hash_secret` is unchanged and still correct for high-entropy bearers (claim
  tokens, device codes, session ids), where there is no searchable preimage
  space. The doc comment now says so.
- The Host logs an error and continues with an empty pepper when
  `OPENSESAME_CLAIM_PEPPER` is unset in production, matching how the operator
  token behaves rather than refusing to boot.

## Gates

`cargo test --workspace`, `cargo clippy --workspace --all-targets -D warnings`,
`pnpm test`, `pnpm run typecheck`, task-security-battle-test, cargo-audit,
cargo-deny, semgrep, ast-grep, osv-scanner, gitleaks, cve-lite — all clean.
