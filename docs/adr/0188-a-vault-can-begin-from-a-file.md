# ADR 0188 — A vault can begin from a file

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [ADR 0115](0115-front-door-and-connector-directory.md) and
  [ADR 0150](0150-live-sessions-browser-to-browser.md) §1 (the front door has a
  third road, beside Set up your own and Join a session)
- **Builds on:** [ADR 0052](0052-password-manager-ecosystem-bridging.md) §6 (the
  import pipeline), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (nothing optional loads before consent),
  [ADR 0160](0160-the-device-identity-plane-is-declared.md) §5a (a backup's identity key
  is taken only when asked), [ADR 0180](0180-vaults-are-sealed-by-passkey-not-password.md)
  (a new vault is sealed with a passkey or a PIN)

## Context

Export writes an encrypted backup (`opensesame-offline-backup-….json`), and the
vault's Import key reads it back, a `.env` file (the first format in the
pipeline's detection chain) and every other manager's export. But that sheet
lives inside an unlocked vault. A device with no vault had no road to it: a
person holding a backup, or a `.env` file they wanted sealed first, saw a front
door that offered setting up or joining, and had to seal an empty vault, find
the Import key, and choose the file there — if they guessed that was the way.
The one thing everybody who already has data wants to do first had no door.

## Decision

### 1. A third road, and the same road on sign-in

The front door's roads are **Set up your own**, **Join a session** and **Import
a file** (full width under the pair; stacked on a phone). The guest Skip is
still the card's corner. Once the door has retired, first-run sign-in carries
the same road as a quiet link beside **Use without an account**. Beside a
sealed vault neither is drawn: there is already a vault to import into, and its
Import key is the road.

### 2. Choosing a file reads nothing; the file waits for the vault

The picker offers what the Import key offers (`IMPORT_ACCEPT`). The chosen
`File` is held in memory (`lib/vault/pending-import.ts`), unread and never
written anywhere. A `File` does not survive a reload, and nothing tries to make
it; the next choice replaces it; the seal screen names it and carries one key,
**Remove file**, which lets it go and gives the road back.

### 3. The vault is sealed the ordinary way

A file waiting for a vault goes straight to the local seal (**Seal this
device**, a passkey or a PIN, ADR 0180), whichever road it was chosen from: it
asks nothing about who the person is, and sign-in (which ends in a navigation
and would drop the `File`) is not offered while a file waits.

### 4. The Import key takes it, once

The vault's Import key (`vault.interop-formats`) takes the held file when it
mounts and opens the sheet every import already uses, so a `.env` previews and
merges, and an OpenSesame backup is opened by its own unlock — its PIN, its
passkey or its master password — and restored by `VaultStore.importSealed`.
The backup's device identity is taken only when the person ticks the choice
(ADR 0160 §5a); this ADR does not change that default.

A backup is not installed as the vault. Its header and body are whatever its
author wrote, the header's `bodyRev` is a rollback witness this device has no
record of, and a backup's identity key ranks against nothing (ADR 0160): the
store already refuses an opened vault that is "older than the last write" and
says to import instead. Importing into a vault sealed here is that road.

### 5. The door imports no pipeline

The bootstrap imports nothing optional (ADR 0130). The pending-file slot, the
picker's accept list and the road itself are core; the pipeline, the sheet and
the key that opens it stay the capability's. The door can hold a file because
it never has to read one.

### 6. A restore does not fail for a chunk, and says what a stale page is

A tab left open across a deploy still names the hashed chunks of the build it
loaded, and the host has since replaced them. The identity modules load when a
restore needs them (`storeImportSeams`), so a stale tab failed a restore with
the browser's own words and a URL. Now:

- a failed chunk fetch is told as the page being out of date, with the remedy
  (`STALE_BUILD`, `lib/chunk-load.ts`), and the Pages import flow asks the
  service worker for the newer build so that the reload reaches it;
- the step that happens after a restore has written — saying what became of the
  device identity — never turns that restore into a failure. It falls back to
  the plain fact that there is something to look at, as `levelDeviceKey`
  already does for the key itself.

A restore that stops before it writes leaves the vault as it was.

## Consequences

- The door has three roads, not two. Its card is taller on a phone by one road;
  the small-screen rhythm (`max-height: 720px`) already gives air back.
- `verify:static` walks the road with a real file chooser, a real seal and real
  WebCrypto: a backup written by one vault is refused by a PIN that is not its
  own and opened by its own in another vault sealed under a different PIN, a
  `.env` file lands as secrets, and Remove gives the door back. Nothing from
  either file is found in the clear afterwards (ADR 0149).
- No new capability or operation: this is a road to `vault.import`, which the
  registry already maps (ADR 0065).
- Not decided here: dropping a file on the door, or importing into a project's
  tomb from the chooser; both can be added without changing the slot.
