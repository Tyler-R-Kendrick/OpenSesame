# Enpass — craft bar (vault sync without a vendor cloud)

> Competitive reference for how OpenSesame's **on-device human vault** reaches
> a person's other devices ([ADR 0144](../../adr/0144-tailnet-vault-sync.md),
> [PRODUCT.md](../../../PRODUCT.md)). Never brand marks; never position
> OpenSesame as an Enpass replacement.

**Stance: craft bar** for sync, **study** for everything else. Enpass is the
password manager most often cited for syncing a vault across devices with no
vendor server in the path, and its model — the storage is a dumb drive, the
merge happens on the device — is the one OpenSesame adopts
([ADR 0144](../../adr/0144-tailnet-vault-sync.md)). The product category stays
an authorization fabric with a sealed human store: Enpass's other features are
recorded below so parity decisions are made knowingly, not to be cloned.

## Overview

[Enpass](https://www.enpass.io/) (Sinew Software Systems) is a cross-platform
password manager: desktop apps for Windows, macOS and Linux, mobile apps for
iOS and Android, browser extensions, and watch apps. Its founding principle is
**data sovereignty** — Enpass never stores a vault on its own
infrastructure.

| Dimension | Enpass |
|-----------|--------|
| Category | Human password manager (personal, family, business) |
| Trust model | Zero knowledge; master password (+ optional keyfile) → PBKDF2-HMAC-SHA512, 320,000 rounds → SQLCipher raw key |
| On-disk format | `vault.json` (plaintext sync metadata), `vault.enpassdb` (SQLCipher, AES-256-CBC), `*.enpassattach` (one SQLCipher file per attachment over 1 KB, own random key) |
| Sync | Bring-your-own: iCloud, Google Drive, Dropbox, OneDrive/SharePoint, Box, pCloud, Nextcloud/ownCloud, any WebDAV, a folder on a network drive, or the desktop's own Wi-Fi Sync Server |
| Merge | Client-side: download the encrypted vault, open it locally, merge, upload if anything changed |
| Business | Enpass Hub (hosted or self-hosted) holds only wrapped vault keys for sharing and recovery (RSA-3072/OAEP) |
| Plans | Personal (from about $1.99/month billed yearly), Family (up to six people, about $3.99/month), Business (from about $35.88 per user per year) — third-party reviews, 2026 |
| License | Proprietary |

Sources (read 2026-09-24): [Enpass Security Whitepaper v1.4](https://www.enpass.io/docs/security-whitepaper-enpass/)
(2025-08-22; the primary source for everything below unless noted),
[Vaults & syncing](https://support.enpass.io/app/sync/sync_and_access_enpass_data_on_all_devices.htm),
[Offline syncing via Wi-Fi](https://support.enpass.io/app/sync/using_wi-fi_sync_in_enpass.htm),
[WebDAV](https://support.enpass.io/app/sync/setting_up_sync_with_webdav.htm),
[Wi-Fi Sync troubleshooting](https://help.enpass.io/personal/latest/all/wi-fi-sync-troubleshooting),
[2FA and passkey support check](https://support.enpass.io/app/audit/kb/use_enpass_to_check_2fa_supported_websites.htm),
and for plans and the import list the 2026 reviews at
[Cybernews](https://password-manager.cybernews.com/enpass-review/) and
[PasswordManager.com](https://www.passwordmanager.com/enpass-review/).

## Feature surface — sync

### Bring your own sync fabric

The cloud is "a dumb drive": it holds the same encrypted vault files that sit
on the device, reached through the provider's official API and OAuth (the
token stays on the device), and never sees a key. Transport is TLS *and*
end-to-end AES-256, so a broken TLS link still carries ciphertext.

### Client-side merge

1. Device A changes something, rewrites its encrypted vault, uploads it.
2. Device B downloads it, opens it locally, merges, and uploads if it had
   local changes.
3. Conflict resolution happens entirely on the device.

Each vault syncs on its own; a person can keep a personal vault on iCloud and
a work vault on SharePoint. Attachments sync as separate encrypted files, so a
large file does not bloat the main database.

### Wi-Fi Sync Server

The desktop app can act as the drive:

- A small **WebDAV server** with a **self-signed certificate**, restricted to
  a folder of the vaults the person shares through it.
- **Discoverable by mDNS** to other devices on the same network.
- A random **access password per vault** — the WebDAV password for that
  vault, so other people on the same network cannot download each other's
  encrypted vaults.
- A **time-based verification code** shown on both devices while pairing,
  because nothing vouches for a self-signed certificate; a mismatch means a
  possible man in the middle.
- A **QR code** pairs a phone without typing either value.
- Works only while both devices are on the same Wi-Fi and the desktop is on.

### Around sync

- **Keyfile** — a 32-byte CSPRNG value mixed into key derivation; the file
  has to be carried to each device.
- **Master password change** propagates with the vault (the key derives from
  it).
- **Business sharing and recovery** go through Enpass Hub, which stores
  wrapped keys only; vault files stay in the organisation's storage.

## Feature surface — beyond sync

### Vault and keys

- **Master password + optional keyfile.** The keyfile is 32 CSPRNG bytes
  mixed into key derivation, a second factor the person carries to each
  device. Key derivation is PBKDF2-HMAC-SHA512, 320,000 rounds, used as a raw
  SQLCipher key (AES-256-CBC, a 16-byte random salt per database, OpenSSL
  libcrypto). No backdoor and no reset for individuals.
- **Attachments** over 1 KB are separate SQLCipher files under their own
  random keys, stored inside the vault.
- **Unlimited vaults**, custom categories, tags, password history.

### Generator, strength and audit

- **Generator:** OpenSSL `RAND_bytes`; pronounceable passwords by Diceware
  over a 14,996-word list (8 words ≈ 110 bits).
- **Strength:** zxcvbn for random passwords, Diceware entropy for
  passphrases (the lower of the two wins), and a master-password meter that
  credits the PBKDF2 work factor. Bands: ≤ 35 bits very poor, 35–50 weak,
  50–70 average, 70–100 good, ≥ 100 excellent.
- **Breach check:** Have I Been Pwned's range API with k-anonymity — five hex
  characters of the SHA-1 leave the device, the match is local.
- **Audit:** weak, reused, old and breached passwords, and which saved sites
  support 2FA or passkeys.

### Passkeys, TOTP and autofill

- Stores and autofills **passkeys** and **TOTP** seeds (an authenticator in
  the vault; password and code fill together).
- **Browser extensions** talk to the desktop app over local WebSockets. Each
  pairs once with a code the person types into the app (an SRP-6a handshake
  whose secret encrypts every later message). The app checks the extension's
  ID and the browser's code signature (except on Linux). It fills only on
  pages matching the saved host, and only after the person picks an item.
- **Wearables** (Apple Watch, Wear OS) hold items marked for the watch,
  protected by the watch OS rather than the vault key.

### Quick unlock

- Mobile biometrics and PIN keep the **master password** in the platform
  keystore (iOS Keychain + Secure Enclave, Android Keystore). New biometrics
  enrolled on the device invalidate it, and five failed quick-unlocks erase
  it. On desktop: Windows Hello (TPM), Touch ID, or a fallback biometric/PIN
  that only re-opens a vault still loaded in memory.

### Sharing and business (Enpass Hub)

- **Item sharing with a pre-shared key.** A person generates a PSK for a
  recipient and sends it over another channel. Items are encrypted under it.
  Sharing is one-way, cannot be revoked, and must be re-sent after edits.
- **Enpass Hub** (hosted or self-hosted) holds only wrapped keys. Each user has
  an RSA-3072 keypair; shared vaults travel through the organisation's
  OneDrive/SharePoint, and their keys through the Hub. **Access recovery**:
  every business vault key is also wrapped to an organisation recovery key, so
  a recovery admin can unwrap it, re-seal it under a one-time secret and send
  the person a two-hour link. Security audit and event logs are available to
  admins.
- Apps authenticate to the Hub with a one-minute JWT from the licence server,
  with optional certificate pinning.

### Import and export

- Imports from other password managers (1Password, NordPass, Password Safe
  and others) and CSV, and exports its own formats.

## Differentiators (why people pick Enpass)

- No vendor account and no vendor server: the vault lives where the person
  already keeps files.
- Offline-first; sync is optional and per vault.
- The Wi-Fi Sync Server keeps a household's vaults off every cloud.
- One app with passkeys, TOTP, audit and autofill at a low flat price.

## Sync: where OpenSesame stood, and what ADR 0144 changes

Proof: [`spec/conformance/vault-drive-protocol.json`](../../../spec/conformance/vault-drive-protocol.json)
(replayed by the daemon and the Pages client), the two-device suite
`packages/app-core/src/lib/tailnet-sync/two-devices.test.ts`, and
`pnpm --filter @opensesame/pages verify:tailnet-sync` (a real daemon and two
browsers).

| Enpass capability | OpenSesame before | OpenSesame after ADR 0144 |
|-------------------|-------------------|---------------------------|
| Sync a vault to the person's other devices | **Gap.** Pages had a push-only encrypted backup to a git remote; no pull, no restore | **Closed.** Tailnet drive: the `opensesame` daemon holds one sealed snapshot per slot; each device pulls, merges and pushes |
| Client-side merge, conflicts resolved on the device | Library only: `mergeVaultBodies` and `VaultStore.mergeSnapshot` had no caller | **Closed.** `tailnet-sync/engine.ts` runs read → merge → compare-and-set write, retrying when another device wins the race |
| Deletes survive a merge | **Gap.** Purge, empty trash and folder delete left no trace; a stale device would have brought them back | **Closed.** `VaultBody.tombstones` carries id → time; an edit made after the purge still wins |
| Storage never holds a key ("dumb drive") | The git backup already shipped ciphertext only | **Kept.** The drive checks only that a snapshot says it is one; it cannot open, forge or alter one, and a replay merges as a no-op |
| Wi-Fi Sync Server on the desktop | None | **Surpassed.** The daemon is the server, reached through Tailscale Serve: a real certificate (no verification code to compare), tailnet-only, and it works on cellular — not just the same Wi-Fi |
| Per-vault access password | — | **Matched.** A 256-bit slot key per slot; the drive keeps only its SHA-256 |
| QR pairing | — | **Matched.** `opensesame daemon drive create` prints a QR of a link that fills the code into Settings › Vaults; the code rides in the fragment and is dropped from the address bar |
| mDNS discovery | — | **Not needed.** MagicDNS names the machine; the pairing code carries the address |
| Set up a new device from sync | — | **Closed** for the personal vault: pairing on an empty device (or from a guest session) writes the sealed vault in and asks for the master password or a synced passkey |
| Sync status | — | **Closed.** A status glyph on the Tailnet sync panel: in step at a time, syncing, or the reason it failed |
| Keyfile | Passkey PRF and PIN unlocks instead | **Deliberately different.** The PIN wrap never leaves its device (a short PIN is guessable offline); a passkey that syncs through the platform is the carried second secret |
| Master password change propagates | — | **Gap.** Each device keeps its own header; only bodies merge. A changed password must be changed on each device |
| Several vaults, each with its own sync | Several vaults per device (ADR 0089) | **Gap.** Only the personal vault can be set up on a new device from the drive, so it is the one that syncs; project vaults need adoption into their own tomb |
| Attachments sync separately | — | **Gap.** Anything stored outside the vault body is not on the drive yet |
| Cloud storage providers (iCloud, Drive, Dropbox, OneDrive, WebDAV, Nextcloud) | Git remotes only, push-only | **Gap by choice for now.** The drive protocol is two routes over one opaque snapshot, so a WebDAV or object-store adapter is a transport, not a redesign |
| Business sharing / recovery (Enpass Hub) | Identity shares, recovery codes, duress (ADRs 0079, 0091, 0131) | See *Beyond sync* below |

## Beyond sync: where OpenSesame stands

| Enpass capability | OpenSesame | Stance |
|-------------------|------------|--------|
| Master password + keyfile | Master password (600k-round PBKDF2-SHA256), passkey PRF and PIN wraps of one vault key; an authenticator, email or text code as a second step (ADR 0091) | **Different by design.** The second secret is a passkey or a second step, not a file |
| Quick unlock keeps the master password in the keystore | Quick unlock wraps the *vault key* (passkey PRF, PIN); the password is never stored | **Stronger.** Nothing that re-derives the root key is kept |
| Diceware generator, zxcvbn strength | Character and passphrase generators from one spec (`spec/conformance/password-policy.json`), strength estimate on the item and health report | **Matched** (the word list and bands differ) |
| HIBP k-anonymity breach check | Host plane: Pwned Passwords range API with k-anonymity (`crates/breach-intel`, ADR 0080); Pages health report flags weak, reused, old and no-2FA locally | **Matched on the Host plane; the Pages vault does not query HIBP** |
| "Which of my sites support 2FA / passkeys" | Health report flags logins with no TOTP; no catalogue of which sites support it | **Gap** |
| Passkeys and TOTP in the vault | Passkey items (vault-custodied ones can sign), TOTP from one set of conformance cases | **Matched** |
| Browser extension, SRP pairing, host-matched fill | WXT browser extension; keepassxc-protocol and browserpass bridges on the device plane (ADR 0052/0053) | **Craft bar only** — autofill habits, not a clone |
| Wearables | None | **Out of scope** |
| Item sharing by pre-shared key | Secret drops (sealed, one-time, with a TTL) and Identity share grants that can be revoked (ADR 0115) | **Matched, and revocable where Enpass's is not** |
| Business access recovery through a recovery key | Recovery codes stand in for a second step only; nothing can recover a lost master password or passkey | **Deliberate gap.** No party holds a way to unwrap a person's vault |
| Several vaults, categories, tags | Several vaults per device (ADR 0089); item types are manifests, installable at runtime (ADR 0087) | **Matched** |
| Import from other managers and CSV | Bitwarden, 1Password, KDBX/KeePass, KeePassXC, LastPass, Dashlane, NordPass, Proton Pass, browsers, CXF, `.env` | **Gap: no Enpass import.** Someone leaving Enpass has to go through CSV. An Enpass JSON importer needs a real export to build against, not a guessed shape |

## Deliberate non-goals vs Enpass

- **No self-signed certificate ceremony.** A verification code exists because
  nothing vouches for Wi-Fi Sync's certificate; Serve's certificate is
  publicly trusted, so OpenSesame does not ask a person to compare digits.
- **No LAN discovery.** A drive is reachable only inside the tailnet, and the
  pairing code names it; nothing on the local network can find or probe it.
- **No PIN off the device.** Enpass derives everything from the master
  password; OpenSesame's quick-unlock PIN stays on the device that set it.
- **No escrowed recovery.** Enpass Hub can recover a business vault because
  its key is wrapped to an organisation recovery key. OpenSesame keeps no such
  wrap: an authorization fabric that could open a person's vault on an
  admin's say-so would be one more thing to defend.
- **No wearables.** A watch that shows items protected only by its OS is a
  copy outside the vault key.

## OpenSesame mapping

| Enpass concept | OpenSesame |
|----------------|------------|
| Vault file (`vault.enpassdb`) | Sealed tomb body (`VaultBody`, AES-GCM under the vault key) |
| `vault.json` sync metadata | Portable header in the drive snapshot (password wrap, passkey wraps, sealed second steps) |
| Cloud folder / WebDAV share | Tailnet drive slot (`/v1/vault-drive/slots/{slot}/snapshot`) |
| Wi-Fi Sync Server | `opensesame daemon run` + Tailscale Serve |
| Access password | Slot key (bearer, SHA-256 at rest) |
| Verification code | Not needed: Serve's certificate is real |
| QR pairing | `opensesame daemon drive create` → link to Settings › Vaults |
| Client-side merge | `mergeVaultBodies` + tombstones, `syncOnce` |

Related: [bitwarden.md](bitwarden.md), [keepass.md](keepass.md) (§ Sync, such
as it is), [tailscale-identity.md](tailscale-identity.md),
[docs/operators/tailnet-sync.md](../../operators/tailnet-sync.md).
