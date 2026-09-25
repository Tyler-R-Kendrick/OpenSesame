# ADR 0144 — Tailnet vault sync: a dumb drive, a device-side merge

- Status: Accepted
- Date: 2026-09-24
- Amends: [ADR 0128](0128-pages-without-host.md) (Pages no longer speaks
  Host) with a third, bounded exception: the tailnet vault drive
- Builds on: [ADR 0063](0063-encrypted-vfs-tombs.md) (every
  vault is a tomb), [ADR 0087](0087-vault-item-type-plugins.md) §7 (item types
  sync inside the body), [ADR 0048](0048-capability-moded-connector-discovery.md)
  §8 (tailnet whois), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (no backend in front of the door), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (optional capabilities load after consent)
- Research: [docs/research/competitors/enpass.md](../research/competitors/enpass.md)

## Context

A person with a vault on a laptop and a phone expects the two to agree. The
Pages PWA had no way to make them: the only road off a device was a push-only
encrypted backup to a git remote, with no pull and no restore. The pieces a
sync needs were there but disconnected — `mergeVaultBodies` and
`VaultStore.mergeSnapshot` had no caller, and the merge would have brought
back every item purged and every folder deleted on the other side, because a
purge left no trace.

Enpass, the password manager people most often cite for sync without a vendor
cloud, does it with two ideas ([research](../research/competitors/enpass.md)):

1. **The storage is a dumb drive.** The vault file sits on the user's own
   cloud, a folder, or a small WebDAV server the desktop app runs on the LAN
   (Wi-Fi Sync Server). No server holds a key.
2. **The merge happens on the device.** Each device downloads the encrypted
   vault, opens it locally, merges, and uploads if it has local changes.

Wi-Fi Sync has costs we do not need to pay: it serves HTTPS with a
self-signed certificate that the person verifies with a time-based code, it
is discoverable to anyone on the same Wi-Fi by mDNS, and it stops at the edge
of that network. Most people who ask for this already run Tailscale, which
gives every device a stable name, a real certificate through Serve, and an
identity for every connection — and reaches the phone on cellular.

## Decision

**Sync the vault through a tailnet drive: the `opensesame` daemon keeps one
opaque, sealed snapshot per slot, and every device merges on its own side
under its own key.**

1. **The drive.** `opensesame daemon run` serves
   `/v1/vault-drive/slots/{slot}/snapshot` (`crates/daemon/src/vault_drive*.rs`).
   A slot holds one snapshot and a generation counter; `GET` returns both,
   `PUT` replaces the snapshot only if the caller names the current
   generation, else `409` with the generation that won. Device routes take
   the slot's access key as a bearer token — 32 random bytes, of which the
   drive keeps only a SHA-256. The drive checks that a snapshot says it is one
   and nothing more; it never holds a vault key. Slots live in
   `$OPENSESAME_VAULT_DRIVE_DIR` (default the user's state directory), `0700`
   directory, `0600` files, written whole and renamed into place. Each
   generation's snapshot is its own file and the slot's metadata names it, so
   that rename is the one commit point: a crash before it leaves the previous
   generation whole. Slots are counted under the same lock that opens one.
2. **Who reaches it.** Browsers reach the daemon through Tailscale Serve
   (`https://<machine>.<tailnet>.ts.net`), which answers only inside the
   tailnet and carries a publicly trusted certificate, so there is no
   self-signed certificate and no verification code to compare. Native
   devices may use the whois-gated tailnet listener (ADR 0048 §8), which now
   serves the device routes too — whois *and* the slot key. Operator routes
   (open, list, close a slot) take the operator token or the Unix-socket peer
   check, refuse any request carrying `Origin`, and are never on the tailnet
   listener. CORS in the daemon is route-scoped: only the two device routes carry
   `OPENSESAME_CORS_ORIGINS`. Pages accepts a drive only at a `*.ts.net` name, a
   `100.64.0.0/10` or `fd7a:115c:a1e0::/48` address, a bare MagicDNS name, or
   loopback — each shape matched whole, so no public IPv6 address passes as a
   dotless name.
3. **Pairing.** `opensesame daemon drive create` opens a slot and prints a
   pairing code (`opensesame-drive:v1:` + base64url of url, slot, key, label)
   and a QR of a link that carries the code in the fragment, which a browser
   never sends to the server hosting the app. The key is shown once. Pages
   takes the code out of the address bar at boot (`apps/pages/src/lib/pairing-link.ts`),
   whether or not Networking is on or a vault is open, and holds it in memory
   only; the pairing an adopted vault waits for is bound to the tomb it was
   adopted into, and a pass runs only for the tomb its pairing was read from.
4. **The merge.** One pass (`packages/app-core/src/lib/tailnet-sync/engine.ts`):
   read the drive; merge its body into the open vault; if the drive lacks
   anything this device holds, write the sealed body back naming the
   generation read, and on `409` start again. A snapshot that fails its seal,
   names another vault, or is not a snapshot stops the pass — it is never
   overwritten. The merge is `mergeVaultBodies`: newest copy of each item
   wins; deterministic in either order.
5. **Tombstones.** A purged item or a deleted folder now leaves
   `{ id → time }` in the sealed body (`VaultBody.tombstones`). The merge drops
   an item whose tombstone is at or after its last change — an edit made after
   the purge on a device that had not heard of it survives — and drops a
   tombstoned folder, moving its items to the root on both sides. Ids and
   times only, capped at 10,000 per kind, oldest forgotten first. An uninstalled
   item type leaves one too, and each installed type records when it was
   installed (`VaultBody.itemTypesAt`), so an install after an uninstall wins.
   Every edit the merge ranks carries its time: restoring from the trash and
   favouriting stamp the item's `updatedAt`, and a folder rename stamps the
   folder's new `updatedAt` — without it the copy that happened to sort higher
   would win, and a sync would quietly undo the edit.
6. **What leaves the device.** The sealed body and a *portable* header: the
   master-password wrap (600k-round PBKDF2 behind the password policy) and
   passkey PRF wraps (nothing to guess), plus the second-step records that
   are already sealed under the vault key. Never the PIN wrap — a short PIN
   under PBKDF2 is guessable by whoever holds the file — never the password
   hint, and never the device's protection manifest. A vault that only a PIN
   opens cannot be adopted elsewhere; the person is told to add a password or
   passkey on the first device.
7. **A second device.** On a device with no vault, pairing writes the drive's
   sealed body and portable header into the personal tomb (body first, so a
   failure leaves nothing that claims to be a vault) and the person unlocks
   with the master password or a synced passkey. The header on each device is
   that device's own afterwards; only bodies merge. A device already holding a
   different vault is refused, never overwritten.
8. **Where the pairing lives.** Sealed in the tomb at `config/tailnet-drive`,
   readable only while the vault is open, gone when the tomb is destroyed. A
   pairing made before a vault exists waits in memory until the adopted vault
   is unlocked.
9. **When it runs.** Only while the `networking.tailnet` capability is active
   (the Networking feature on Settings › Capabilities, default off), only for
   a paired, unlocked, non-guest vault: on unlock, 1.5 s after a change, and
   once a minute. A guest session never syncs, and a duress decoy runs in its
   own tomb, which holds no pairing.
10. **The deployment fence.** `localNetworkFetch` refuses local-network
    requests from the shared demo origin, because that fence exists to keep
    operator authority off an origin other pages share. A drive request
    carries no operator authority — the operator header is still refused — so
    it passes with `ciphertextDrive: true`.

### Exception to ADR 0128

Pages speaks to exactly one daemon surface: the two device routes of a drive
the person paired, at the address in the pairing code. It never writes
`settings.hostApi`, never sends an operator token, never calls a slot route,
and nothing else in Pages speaks to a daemon.

## Proof

- `spec/conformance/vault-drive-protocol.json` records the protocol as
  literal exchanges; the daemon replays them against its router and the Pages
  client sends and reads them through its real client, so neither side can
  drift alone.
- `packages/app-core/src/lib/tailnet-sync/two-devices.test.ts` runs two
  `VaultStore`s with separate storage against one compare-and-set drive:
  setup from the drive, edits on both sides, a purge and a replayed older
  snapshot, a folder delete, a lost race, a restore from the trash, an
  unfavourite, a folder rename and an item type uninstall all converge, and
  the drive never holds a name, a note or the PIN wrap.
- `pnpm --filter @opensesame/pages verify:tailnet-sync` does it for real: the
  `opensesame` daemon as the drive and two isolated browsers.

## Consequences

- A laptop and a phone on one tailnet keep one vault in step, including on
  cellular, with no vendor cloud and no server that can read it.
- The drive can refuse, lose or replay a snapshot and do nothing worse; a
  replayed snapshot merges as a no-op because the merge only ever adds newer
  copies and honours tombstones it has seen.
- Pairing is a copy of a code or a scan of a QR; there is no certificate to
  verify, because Serve's is real.
- Attachments stored outside the body, project vaults (tombs other than
  `personal`) and a master-password change (each device keeps its own
  header) do not sync in this version;
  the Enpass research lists them as the remaining gaps.
- The client CLI (`opensesame-id`) does not sync; the gap is recorded in the
  capability registry's surface ledger.
