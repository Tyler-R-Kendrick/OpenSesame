# ADR 0209 — A deadman switch is a release envelope with a relay witness

- Status: Accepted
- Date: 2026-10-20
- Builds on: [ADR 0063](0063-encrypted-vfs-tombs.md) (sealed vault bodies),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (device at-rest key),
  [ADR 0162](0162-device-receipts-inbox-and-local-notifications.md) (device
  records), [ADR 0189](0189-settings-features-and-integrations.md) (Settings
  groups)
- Research: [`docs/research/deadman-switch.md`](../research/deadman-switch.md)

## Context

A person wants a small set of vault items to become reachable after a run of
days without authenticating on the device that configured the switch. The
obvious local implementation — a timer that decrypts items after a deadline —
is wrong in a password manager. It gives the release to whoever holds the
device, trusts a clock the holder controls, and has no recipient, warning or
denial path.

Mature products use a trusted contact and a wait (Bitwarden, Proton), a
service-side inactivity plan with a warning (Google), or an access key kept
outside the service (Apple, 1Password). The cryptographic literature treats a
deadman switch as a release protocol to nominees, not a local switch. A
static browser app has no trusted clock, no server that may hold a vault key,
and no background worker that survives a closed tab.

The switch still has one honest local job: the only place that can observe
"this person authenticated on this device" is the device. The relay can own
the deadline and notify a webhook; it must not hold the items or their keys.

## Decision

### 1. Release is a separate envelope, not a vault mode

Arming copies the chosen items into a **release package**, a JSON snapshot
sealed with AES-256-GCM under a fresh 256-bit **release key**. The package is
stored in device-local KV (sealed again under the device at-rest key); it does
not enter the vault body, a sync snapshot or a backup target.

The release key is shown once as `osdm1_…`. It is never stored. The person
must put it somewhere a trusted recipient can reach — a safe, a will, an
emergency kit. The package opens while the vault is locked, with that key and
nothing else.

Consequences: the relay cannot decrypt; the device cannot decrypt alone; a
person who loses the key loses the release; a person who has both the device
and the key can release after the deadline. The UI says all four.

Trash, one-time drops and empty selections are refused. The package carries at
most 200 items and 2 MB of ciphertext. It is a snapshot: later edits need a
new arming, and the package records its creation time.

### 2. The local record is signed; the relay is the time witness

The device holds a public record with the arm time, the last authenticated
unlock, the deadline, the package digest, the item count and the relay URL. It is signed with a freshly generated ECDSA P-256 key. A
second, sealed VFS file inside the vault holds the private key, the relay
bearer and the webhook URL.

The record is signed so a local edit cannot silently move the deadline. The
private half is sealed so a locked device cannot send a heartbeat or read the
webhook. The public half is device-local KV, hydrated before first paint, so
the lock screen can offer the release after a cold load.

The relay owns the authoritative clock. The device sends:

- a signed **arm** record with the public key and the trusted webhook at
  commit;
- a signed **heartbeat** after every authenticated unlock, with a monotonic
  sequence and the authentication time;
- a signed **disarm** when the owner turns it off.

The relay must publish the public key with the arm record, treat a missing,
late or invalid heartbeat as the event, send the webhook a release event, and
reject replayed or stale heartbeats. The browser sends a schedule, a package
digest and a public key; it never sends an item, an item name, a vault key or
the release key. This is a contract, not a bundled service: a person who wants
the relay must name an HTTPS endpoint (loopback HTTP is allowed only in
development). The webhook must be HTTPS and is stored only in the sealed half.

Authentication means a successful local vault unlock (PIN, passkey or master password, with any second step); merely opening the tab is not authentication. The local deadline is `lastAuthenticatedAt + timeoutDays`. A wall-clock
rollback can only delay the local offer; a forward jump can only reach the
release screen, where the release key is still required. The relay's server
time is what decides whether an external event fires.

### 3. Two-phase arming

Preparation does all the expensive local work and stores nothing:

1. choose 1–200 items and a window of 1–3650 days;
2. generate the release key and the ECDSA pair;
3. seal the snapshot and prove the displayed key opens it;
4. show the key once.

Commit is a separate press after the person acknowledges the key is stored
elsewhere. It registers the signed record with the relay, then writes the
sealed private record, the package and the public record. If any write fails,
the client sends a signed disarm and removes the partial local state. A relay
that refuses the arm fails the commit.

Disarm needs the relay's acknowledgement before the local records are removed.
A local "off" that leaves a relay counting down would be a lie.

### 4. Release is a locked-screen road with a key

After the signed deadline, the unlock screen draws one road, **Open deadman
switch**. It opens `/deadman`, an ungated screen with no vault key. The screen
verifies the signed record, checks the package digest, and asks for the
release key. Only then does it decrypt the snapshot in the tab.

The screen lists the released items read-only. It never unlocks the vault,
never exposes the vault key and never writes the release key back to storage.
Leaving clears the tab's copy. The relay's release event and the local screen
are independent: the event tells a trusted contact to find the device and the
key; the local screen is what opens the package.

An owner who unlocks before the deadline resets it. The next authenticated
unlock is the strongest possible "still here" signal this device has. A relay
heartbeat follows the local write; a relay outage never blocks the unlock, and
the settings row reports the last local deadline either way.

### 5. Device-only is the boundary

The state and package are device-local KV, keyed by tomb. The private half is
a sealed VFS file in that tomb. Nothing here is added to a vault body, a
merged snapshot or a backup export. A second device that restores a backup may
receive the sealed private file, but it does not receive the device-local
package, so it cannot release anything.

The switch is absent in a guest or decoy session. It draws only for the owner
of an open vault, in Settings › Security, after Duress. The release road draws
only after the deadline; an ordinary lock screen says nothing about the
switch.

## Threat model

| Adversary | What they get | What stops them |
| --- | --- | --- |
| Thief with the locked device before the deadline | The signed public record and ciphertext | No release screen; no release key |
| Thief with the locked device after the deadline | The release screen and ciphertext | The 49-character release key is not on the device |
| Thief who edits the local deadline | An earlier release screen | The ECDSA signature fails; the release refuses, and the key is still absent |
| Thief who rolls the clock forward | The release screen | The key is still absent; the relay uses its own clock |
| Compromised relay | The schedule, package digest, public key and webhook | No item, no vault key, no release key |
| Compromised webhook | The release event and public key | No item, no vault key, no release key |
| Person who loses the release key | Nothing | The package is unrecoverable by design |
| Person who loses the device | The notification only | The package was never uploaded; this is an honest availability loss |

## Consequences

- New core module `packages/app-core/src/lib/deadman/` (package, state,
  relay, arm). The state and package keys join the boot hydration for the
  active tomb; `switchVault` hydrates them for the next vault.
- `VaultStore` records a successful unlock with the deadman module after the
  vault body is open. It awaits the local record write and leaves the relay
  heartbeat in the background.
- Settings › Security gains a **Deadman switch** row and sheet. The sheet has
  item choices, a window, relay and webhook fields, a one-time release key and
  an explicit acknowledgement.
- The unlock foot gains a road that exists only after the deadline, and
  `/deadman` is a core ungated route.
- Tests cover the package round trip, a wrong key, the deadline, the
  authenticated-unlock reset, relay refusal and disarm. The browser walk uses
  a local relay and Playwright's clock to release a real item after a reload.
- The relay is not bundled. That is deliberate: the contract is small and a
  person may already run a heartbeat monitor. The repository documents the
  required event and signature shape rather than pretending a static page can
  run a durable timer.

## Alternatives considered

- **A local timer that decrypts for anyone.** Rejected: it is a delayed
  disclosure to whoever holds the device, and it trusts a clock the holder
  controls.
- **Encrypt the package to the relay's key.** Rejected: the relay would become
  a decryption authority and could release early. The relay is a witness, not
  a custodian.
- **Store the release key on the device until the deadline.** Rejected: any
  local attacker can read it, and a clock edit releases early.
- **Auto-release at the deadline without a key.** Rejected: no recipient, no
  denial window, and no way to distinguish the owner from a thief.
- **A server-side inactivity account.** Rejected for this device-only feature:
  it needs a durable identity and a server that sees authentication; the
  browser has neither in the static deployment.
- **Shamir shares to a committee.** Rejected for the first cut: it needs
  independent custodians and a recovery protocol. The release envelope is the
  same "only a nominee can open it" property with a key the owner can hand
  over today.
