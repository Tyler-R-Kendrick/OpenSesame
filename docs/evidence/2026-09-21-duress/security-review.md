# Security review (interim)

## Findings addressed in this run
- Forged AccessContext JSON copies do not authenticate.
- PRF-alone / code-alone cannot open prf_and_code envelopes.
- Alert status authority is checked; relay cannot human-ack.
- Canary/destructive injection rejected at schema/executor (module present).
- Local removal does not claim forensic erase; unsupported wipes flagged.
- Feature-off format refusal for armed higher versions.

## Residual risks (explicit)
- Browser local holds are not tamper-resistant clocks.
- Historical offline snapshots + old keys remain decryptable.
- Alert delivery is best-effort; browser may terminate before flush.
- Concurrent swarm test suites still include API-alignment failures — not force-passed.
- Physical WebAuthn/PRF hardware and live provider revocation not verified in this environment.
- Host live authority hold remains optional and environment-dependent.
- Two-input duress (UV+code / PRF+code) unlock UI is wired (passkey ceremony → code → complete-code); hardware WebAuthn/PRF live proof remains environment-dependent.

## Rejected unsupported claims
Personal safety, undetectability, forensic erasure, UV⇒biometrics, emergency response guarantee.

## REDTEAM finding log (adversarial verification)

| ID | Severity | Summary | Reproduction | Owner request | Status |
|---|---|---|---|---|---|
| RT-BACKUP-001 | high | `%2E%2E` path traversal still allowed | `bypasses.test.ts` | `REDTEAM-to-BACKUP.md` | closed |
| RT-AUTH-001 | high | Active fence + null AccessContext → operator | `rbac-fence.test.ts` | `REDTEAM-to-AUTH.md` | closed |
| GAP-UNLOCK-WIRE | high | Missing duress unlock bridge | `gaps.honest.test.ts` | `REDTEAM-to-SETTINGS-unlock-wire.md` | closed |
| GAP-SETTINGS-NAV | medium | Panel not mounted in security shell | `gaps.honest.test.ts` | `REDTEAM-to-SETTINGS-nav.md` | closed |
| GAP-PEER-CRYPTO | high | `duress_receiver` verify lacks ECDSA | `packages/redteam/.../gaps.honest.test.ts` | `REDTEAM-to-PEER-crypto.md` | closed |
| RT-CONTRACT-001 | medium | nondurable storage compile edge | `compiler-fuzz.test.ts` | `REDTEAM-to-CONTRACT-durable.md` | closed |
| RT-CANARY-001 | high | Nested destructive canary parse | `bypasses.test.ts` | `REDTEAM-to-CANARY.md` | closed |
| RT-CANARY-002 | critical | `isIntegereger` typo | `canary-schema.test.ts` | `REDTEAM-to-CANARY.md` | closed |

Report: `.duress-swarm/reports/REDTEAM.md`. Open findings remain failing tests — not force-passed.

## Closed in COORD follow-up (REDTEAM findings)
- **RT-BACKUP-001:** `assertOwnedPath` decodes percent-encoding and rejects `%2E%2E` / `%2e`.
- **RT-AUTH-001:** Active fence with null `AccessContext` forces guest (no custodian promotion).
- **RT-CONTRACT-001:** Compiler rejects profile-bearing policies when `catalog.durableStorage` is false.
- **GAP-UNLOCK-WIRE:** PIN/password/second-step complete-code gates + post-match guest continue; passkey refuses two-input-armed solo unwrap.
- **GAP-SETTINGS-NAV:** `SettingsSection` mounts `DuressEnrollmentPanel` when mode is non-off; `SettingsSecurity` hosts `DuressProfilesPanel`.
- **GAP-PEER-CRYPTO:** `duress_receiver/verify.rs` performs ECDSA P-256 verify before replay admit.
