# Audit tick 45 — the vault trusted KDF parameters it got back from the server

Date: 2026-08-08
Scanners: cve-lite, semgrep, ast-grep, gitleaks, clippy, cargo-audit, osv-scanner, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `unwrap_vrk_with_password` read `params_m_kib`, `params_t`, and `params_p` straight out of the stored `PasswordWrapper` and handed them to Argon2. The wrapper round-trips through a server the design explicitly does not trust (server-blind E2EE), so those are attacker-chosen: `params_m_kib = 4 * 1024 * 1024` asks the client to allocate 4 GiB to unlock a vault, and a downgrade to `m = 8, t = 1` yields a wrap that an offline guesser can grind cheaply. | `assert_argon_params_accepted` bounds the work band (64 MiB–1 GiB memory, t 3–16, p 1–4) and is checked before any hashing; out-of-band wrappers answer `KdfParamsOutOfRange`. |
| Medium | The unwrap path ended in `out.copy_from_slice(&key)`, which panics whenever the authenticated plaintext is not exactly 32 bytes — a wrapper produced by any other version of this code crashes the client instead of failing. | Length is checked and returns `KeyLength`; the decrypted buffer is zeroized on both paths, as are the Argon2 output and the derived KEK. |
| Medium | `decrypt_item` checked `envelope.version` but ignored `envelope.ad.envelope_version`, so a re-digested envelope could declare a different AD version while the header stayed at 1 and the version gate never fired. | Both must agree, or decryption refuses. |
| Medium | `startCleanupLoop` (worker) had no error boundary: one throwing tick ended the loop, and with it claim, session, and project expiry — credentials would outlive their TTL for as long as the process stayed up, silently. | The tick is wrapped, the failure is logged, and the loop continues on the next interval. Covered by a test that throws on the first tick and asserts the loop keeps going. |

## Notes

- Zeroizing intermediates matters here because `VaultRootKey` is `ZeroizeOnDrop` while
  the material it was derived from was not — the wrapper key lived on in the stack frame.
- No TypeScript mirror of the password wrapper exists yet, so the band only needed
  enforcing once; if `packages/client-crypto` grows one, it must carry the same bounds.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test -p opensesame-human-vault` — 12 passed (3 new)
- `pnpm --filter @opensesame/worker test` — 2 passed (1 new)
- semgrep, gitleaks, cve-lite, ast-grep, cargo-audit, osv-scanner, cargo-deny — clean
