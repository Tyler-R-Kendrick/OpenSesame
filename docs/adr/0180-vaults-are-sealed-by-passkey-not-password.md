# ADR 0180 — A new vault is sealed by a passkey, never a master password

- **Status:** Accepted — Pages unlock and Security surfaces implemented; vault-key rotation, the CLI and Node host still create password wraps (see Consequences)
- **Date:** 2026-10-06
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0091 ([account exits and the unlock ceremony](0091-account-exits-and-unlock-ceremony.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md))

## Context

The unlock screen and Settings › Security offered three ordinary keys: a
passkey, a PIN and a master password. The master password is the one typed
secret a person can reuse, phish and lose to an offline attack on the
exported header, and it needs a strength meter, a reminder and a "forgot it"
story that a passkey does not. Products such as [Pocket ID](https://pocket-id.org/)
take the other road: the only way in is a passkey.

## Decision

1. **The Pages app never creates a master password.** First-run sealing
   (`unlockMethodTabs`) offers a passkey, or a PIN where the browser cannot
   make one — no Password tab, no strength meter, no unlock reminder, no
   confirm field. `submitFirstRunUnlock` refuses any method but those two.
2. **Settings › Security never adds or changes one.** The Password row is
   drawn only on a vault that already holds a password wrap, and its one
   action is Remove (ADR 0158: a row acts or is absent). `SecretKeyCard` is
   the PIN card; there is no password card and no "Use a password instead"
   alternative in any key sheet. The tutorial "Change the master password"
   and its `settings.master-password` target are gone.
3. **An existing vault still opens.** A header that already carries a
   password wrap keeps its Password tab at unlock, exactly as before — the
   header on disk says which challenges the vault enrolled, and removing the
   tab would strand data that has no recovery. The person is moved off it
   from Settings: add a passkey, then Remove the password (refused while it
   is the last key, as ever).
4. **The storage primitives stay.** `VaultStore.create(password)`,
   `unlock(password)`, `enrollPassword` and `changeMasterPassword` remain in
   `@opensesame/app-core` because the CLI (`opensesame-id`, no WebAuthn), the
   Node host, the offline-backup reader and the test fixtures need a typed
   key. No Pages screen calls the three that create or change one.

## Consequences

- **A PIN does not leave the device.** The tailnet-sync snapshot carries the
  password wrap and passkey PRF wraps but deliberately not the PIN wrap
  (`tailnet-sync/snapshot.ts`). With the password gone, a vault that should
  open on a second device needs a passkey; a PIN-only vault stays on its
  device. This is the existing rule, now with one fewer portable road.
- **Open follow-ups, not done here:** (a) *Rotate compromised vault key*
  (`rotateCompromisedRoot`) still re-wraps under a typed password, and a
  vault with none gets "the password entered becomes the master password";
  it needs a passkey re-enrolment design. (b) The PIN is still a typed
  secret; "passkeys only" in the strict sense would remove it too, and with
  it the first-run road on a browser with no WebAuthn. (c) The CLI and
  `opensesame vault verify` still unlock by master password.
- Browser journeys that sealed a vault with a password (`verify:*`) seal
  with a PIN instead, or with a virtual WebAuthn authenticator where the
  second device must adopt the vault.
