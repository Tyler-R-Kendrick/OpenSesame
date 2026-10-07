# ADR 0180 — A new vault is sealed by a passkey, never a master password

- **Status:** Accepted — implemented in Pages, including vault-key rotation; the CLI and Node host still use typed passwords (see Consequences)
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
5. **Vault-key rotation never creates a password.** A vault that holds one
   proves it and keeps it, as before. Any other vault is re-keyed under a
   new passkey (the wrap is made, and the prompt answered, before any key
   changes), or under a new PIN where WebAuthn cannot run
   (`rotateCompromisedRoot({ passkey: true } | { pin })`). A password
   offered to a vault that holds none, or a passkey to one that does, is
   refused.
6. **The PIN stays, deliberately.** A passkey needs a secure hostname and a
   WebAuthn PRF authenticator, and the browser cannot tell which until the
   ceremony runs, so a vault with no typed road would strand people on
   authenticators without PRF. The PIN is a device-local key that never
   syncs, and the duress code shares its field. It is the explicit fallback,
   not a peer of the passkey; if a future browser reports PRF support before
   the ceremony, the PIN tab should be drawn only when that says no.

## Consequences

- **A PIN does not leave the device.** The tailnet-sync snapshot carries the
  password wrap and passkey PRF wraps but deliberately not the PIN wrap
  (`tailnet-sync/snapshot.ts`). With the password gone, a vault that should
  open on a second device needs a passkey; a PIN-only vault stays on its
  device. This is the existing rule, now with one fewer portable road.
- **A fix found on the way.** Rotating the key re-sealed only the body, so a
  vault with any other sealed file (the tomb index at least) failed to unlock
  after a rotation. `rekeyTomb` now re-seals every file first, all-or-nothing.
- **`verify:tailnet-sync` seeds its first device through the store.** Its
  second device must adopt a vault from a wrap that travels: a PIN never does,
  a password can no longer be made by a screen, and Chromium's virtual
  authenticator does not carry a credential's PRF secret across devices
  (`WebAuthn.getCredentials` omits it; probed). So device A's vault is sealed
  under a master password by `fixtures/vault-seed.ts` (the way
  `fixtures/local-iam.ts` seeds), and both devices unlock it from the screen.
- **Still typed passwords:** the CLI (`opensesame-id`, no WebAuthn), the Node
  host, `opensesame vault verify` and the test fixtures. No Pages screen calls
  `VaultStore.create`, `enrollPassword` or `changeMasterPassword`.
- Browser journeys that sealed a vault with a password (`verify:*`) seal
  with a PIN instead.
