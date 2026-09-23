# Audit 2026-09-23 — Sealed-store root protection and CLI secret handling

## Findings reproduced in this change

1. **`pass protect root-rotate` destroyed the store.** It minted a new root,
   rewrapped the password record, overwrote `.opensesame-key` and dropped the
   old root — but entries and attachments are sealed directly under the root
   (`ItemDataKey(vrk.0)`) and none were re-encrypted, so nothing opened
   afterwards. **Fix:** `rotate_store_root` (`crates/sealed-store/src/rotation.rs`)
   plans the new manifest without writing (`prepare_root_rotation`), opens
   every `.osseal` entry and `.osattach` manifest with the old root, reseals
   each chunk and manifest under the new one into `.opensesame-rotation/`,
   persists the new key file there, swaps the staged files in with the old
   ciphertext kept aside, and renames the key file into place last. Any
   failure before that rename restores the previous files; the key file is
   written atomically (temp, fsync, rename) on every path. Age capsules are
   resealed to their recorded recipients; a recovery key cannot follow a new
   root and is reissued only with `--reissue-recovery --reveal`.
   **Test:** `rotation_tests.rs`, `apps/cli/tests/protect_rotation_journey.rs`.

2. **The last password could be removed beside a recovery key.** Removal was
   allowed while any recovery record remained, but every native unlock path
   reads a password record; a recovery key is only ever tested. **Fix:**
   `remove_record` refuses to remove the last password record regardless of
   other protectors. **Test:** `last_password_is_kept_even_beside_a_recovery_key`.

3. **`rewrap` and `remove` did not revoke.** The root was unchanged, so the
   previous `.opensesame-key` in git history or a pushed remote still opened
   the store with the old passphrase or the removed recovery key. **Fix:**
   both verbs rotate the root by default. `--no-rotate` keeps the old
   behaviour and prints that nothing was revoked. **Test:**
   `rotating_rewrap_revokes_the_old_passphrase_and_old_key_file`,
   `rotating_remove_revokes_a_removed_recovery_key`.

4. **Secrets on argv.** `pass protect recovery test <RECOVERY>` and
   `pass otp validate <URI>` took the recovery key and the TOTP seed as
   positional arguments, which shell history and `/proc/<pid>/cmdline` keep.
   **Fix:** both read from a hidden prompt or stdin; clap refuses the
   positional form. **Test:** `recovery_test_refuses_the_secret_on_argv`,
   `validate_refuses_the_uri_on_argv`.

5. **`pass otp uri` printed the TOTP seed without the reveal gate.** **Fix:**
   `--reveal` and `require_reveal` before unlocking, as `pass show` does.
   **Test:** `uri_is_withheld_without_reveal_off_a_terminal`.

## Hardening in the same change

- The daemon duress receiver refuses envelopes issued more than five minutes
  in the future, lifetimes over 24 hours (the Pages `PEER_BOUNDS`), and
  backwards timestamps. Its replay cache evicts nonces once their envelope
  expires instead of refusing every envelope after 4096.
- Host duress: `supersede_incident` requires the hold's authority and epochs,
  as resolving does; `accept_independent_hold` no longer overwrites an
  accepted hold — an identical re-delivery is idempotent, another authority
  or changed terms are refused.

## Residual

- Rotation is not retroactive: ciphertext and key files already in history
  open with the old root, and `pass restore` cannot open pre-rotation
  versions under the new one.
- A process that holds the old key in memory (password-manager bridges, the
  connector host) keeps sealing under the retired root until restarted.
- A crash mid-swap needs manual recovery from `.opensesame-rotation/`; the
  next rotation refuses until it is resolved, but other store verbs do not
  check for it.
