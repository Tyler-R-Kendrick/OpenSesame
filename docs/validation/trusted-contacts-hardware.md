# Trusted contacts: the hardware pass

What `pnpm --filter @opensesame/pages verify:quorum-browser` proves, what it
cannot, and the manual protocol for the rest. ADR 0187 states the limit this
page closes: *"Not exercised against physical hardware."*

## What is already verified, and where

| Layer | How | Where it runs |
|---|---|---|
| The protocol (SLIP-0039, HPKE, policy, ledger, epochs, packets) | 45 official SLIP-0039 vectors, RFC 9180 Appendix A.1/A.2, ~300 unit tests, mutation checks | `pnpm --filter @opensesame/app-core exec vitest run src/lib/quorum` |
| The ceremonies end to end, many devices, hostile pastes | the desk, one in-memory device per person, a JS virtual authenticator | `src/lib/quorum/desk/desk.*.test.ts` |
| **A real browser's WebAuthn stack with PRF** | five Chromium contexts, five CDP virtual authenticators with `hasPrf`, the real desk in each page, only packets between them; refusals are the browser's own (`NotAllowedError`) | `pnpm --filter @opensesame/pages verify:quorum-browser` (CI: `sign-in` shard) |
| The Settings screens | `verify:trusted-contacts` (keyboard, touch, tutorials) | see the screens' own gates |

A CDP virtual authenticator runs Chromium's WebAuthn code (real `create` and
`get`, real `clientDataJSON`, authenticator data, signatures, the PRF
extension). It does **not** run a vendor's firmware, a platform's secure
enclave, or another browser's WebAuthn implementation. Those are this pass.

## What only hardware can show

1. **PRF output is stable and per credential on a real key.** The share is
   wrapped under a key derived from the PRF output; if a key's output changed
   between sessions the share would be lost. Enrollment and hand-over reopen the
   share with a *fresh* assertion before a guardian is told it worked, which
   catches this at once, but only a real key shows whether it happens.
2. **`hmac-secret` over USB and NFC, and over hybrid (a phone as the key).**
   Some transports and some firmware do not return PRF, or return it only on
   `get()` and not on `create()`. The engine asks on `get()` always.
3. **User verification.** A PIN or biometric prompt must appear when the circle
   requires it, and an approval must fail without it.
4. **Platform passkeys** (iCloud Keychain, Google Password Manager, Windows
   Hello) and whether PRF survives their sync.
5. **Safari and Firefox.** The engine uses only `navigator.credentials` with the
   `prf` extension; support and quirks differ by browser and version.
6. **Backup keys.** A second key registered for the same guardian must unwrap
   the same share (each key has its own wrapped copy) and cast no second vote.

## The protocol (about 20 minutes per pair)

Use a throwaway vault and a throwaway circle. Two people are enough: the
guardian under test, and an owner/recipient on a second browser profile.

For each pair *(authenticator, browser + OS)* below:

1. **Enroll.** The guardian opens the owner's invitation, names the key, and
   touches it (with PIN/biometric if prompted). **Expect:** enrollment succeeds;
   the contact row shows the key as able to hold a share (PRF seen). If the key
   does no PRF, the owner's *Make the circle* refuses a circle that holds shares
   with `no_prf`, and an approvals-only circle still works. Record which.
2. **Take the share.** The owner pastes the enrollment, makes a 2-of-3 (use two
   more throwaway guardians or the same key under three names on separate
   profiles), and sends the welcome. The guardian pastes it. **Expect:** two
   touches (wrap, then reopen), then a receipt; the owner pastes the receipt and
   the row shows the share held.
3. **Next day.** Unplug, close the browser, lock and unlock the vault. Approve a
   request. **Expect:** approval succeeds with a touch. Then release (after the
   delay or with the test's short delay) and recombine. **Expect:** the payload
   is recovered. This is the stable-PRF check.
4. **Refusals.** Cancel at the PIN prompt: expect a clear failure and no packet.
   Use a different physical key than the one enrolled: expect failure.
5. **Backup key.** Register a second key for the same guardian; unplug the first;
   release with the second. **Expect:** it works, and the ledger counts one
   guardian.

## Matrix to fill in

Record version numbers, the date, and *pass / fail / not supported* with a note
for every cell. **Nothing in this table has been run.** An empty cell means
"unknown", not "works".

| Authenticator | Chrome | Edge | Safari | Firefox | Notes |
|---|---|---|---|---|---|
| YubiKey 5 (USB-A/C, FIDO2.1, firmware ≥ 5.4) |  |  | n/a on iOS USB |  |  |
| YubiKey 5 NFC (phone) |  |  |  |  |  |
| Security Key by Yubico (FIDO2, no PIN set) |  |  |  |  | UV likely fails: record |
| Google Titan |  |  |  |  |  |
| Platform: Windows Hello |  |  | n/a | n/a |  |
| Platform: macOS Touch ID / iCloud Keychain | n/a |  |  |  |  |
| Platform: Google Password Manager (Android/Chrome) |  | n/a | n/a | n/a |  |
| Hybrid: phone as the key (QR + Bluetooth) |  |  |  |  |  |

When a pair fails, keep the browser's own error (name and message), the
authenticator and firmware, and whether `prf.enabled` came back at `create()`.
File the result under `docs/evidence/<date>-trusted-contacts-hardware/` and link
it here. A pair that cannot do PRF is not a defect in the circle: it is a key
that belongs in an approvals-only circle, and the owner's screen says so.

## Reading the result

* All cells for your supported browsers pass: remove "not exercised against
  hardware" from ADR 0187's limits and say which pairs were tried.
* A pair fails: record it as a *supported keys* line in
  `docs/operators/trusted-contacts.md`. Do not special-case the engine for one
  firmware; the policy's `no_prf` check and the reopen-at-hand-over proof are
  what keep a bad key from ever holding a share.
