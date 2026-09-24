# ADR 0143 — Travel mode

- Status: Accepted
- Date: 2026-09-24
- Builds on: [ADR 0063](0063-encrypted-vfs-tombs.md) (every vault is a tomb),
  [ADR 0089](0089-device-vault-switching.md) (one list of the device's
  vaults), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (complete without a backend),
  [ADR 0130](0130-duress-profiles-trust-boundaries.md) (duress trust
  boundaries)
- Research: [`docs/research/travel-mode.md`](../research/travel-mode.md)

## Context

1Password's Travel Mode lets a traveller mark vaults **Safe for Travel**. When
it is switched on (on the web, never on the device), every other vault is
deleted from the traveller's devices and comes back when it is switched off.
It is the only shipped travel mode among mainstream password managers.
Bitwarden and Proton Pass both have open requests for one.

The design has two well-known weaknesses. First, the traveller can switch it
off on demand, because the web sign-in works from the device they carry. So
"please turn it off" is a request they cannot truthfully refuse, and hiding
that it exists invites a lie at the border (Schneier, 2017 and 2018).
Second, it depends on a server that holds the vaults while they are away.

OpenSesame Pages has no such server (ADR 0090). What it does have is a device
that already holds several vaults, one tomb each (ADR 0063, ADR 0089), and an
opt-in duress feature that reacts at the moment of coercion (ADR 0130).
Travel mode fills a different need: deciding, before the trip, what is on the
device at all.

## Decision

### 1. Carry the vaults marked safe; everything else leaves

The traveller names the vaults that are **safe for travel**. Every other
sealed vault on the device **departs**: the one they did not think about
stays home by default. Planning (`lib/travel/plan.ts`) is pure and refuses to:

- take away the vault that is open (`open_vault_departs`), because its key
  is in memory;
- name a vault the device does not have (`unknown_vault`);
- run a departure in which nothing leaves (`nothing_departs`).

The guest road and never-sealed vaults take part in neither list.

### 2. A vault leaves whole, in a bundle under a return code

A departing vault is every origin file its tomb holds, plus the plaintext
records named for it: the lockout counter, site-broker consents and the
offline ciphertext cache. The files are found by the storage layer's own file
names (`lib/travel/storage.ts`, longest tomb stem wins), not by a list of
modules that would go stale the day someone adds a config file.

The files are already ciphertext, apart from the plaintext header. They are
sealed once more into a **travel bundle** (`opensesame.travel-bundle`, v1),
using AES-256-GCM:

- The key is derived with HKDF-SHA-256 from a fresh 144-bit **return code**,
  salted with the bundle id.
- The AAD binds the format, the version and the bundle id.
- Outside the seal the bundle carries only the format tag, the version and a
  random id. No vault id, name, count or date appears in the clear.

The return code is 32 base32 characters with a 2-byte check. It is shown
once and never written to the device. The check lets a typo read as a typo
(`code_malformed`) rather than as a wrong code (`code_mismatch`).

### 3. Two steps; nothing is removed until both halves are elsewhere

`packDeparture` writes nothing. It reads, seals, and then proves the round
trip: the displayed code opens the bundle, and the bundle holds exactly the
bytes read (a SHA-256 fingerprint).

`completeDeparture` goes ahead only after the person confirms two things:
the bundle is saved somewhere other than this device, and the code is
recorded somewhere they will not carry. It then re-reads the files. If a
vault changed after it was packed, it refuses with `changed_since_packed`.
Otherwise it deletes the files, unregisters the tombs, drops the vaults from
the project list and the active pointer, and lists the device again. The
**receipt** reports what is actually gone. Its `leftovers` field names any
file that survived.

### 4. The lock is held off the device, and that is the honest answer

The carried device holds neither the bundle nor the code. However
thoroughly the traveller is compelled, including their vault passwords, the
departed vaults cannot be opened from what they carry. "I cannot open that
from here" is then **true**. That removes the pressure toward deception that
1Password's design creates. The product does not describe travel mode as
undetectable, and neither should anyone using it:

- There is **no on-screen travel indicator**, because there is nothing on
  the device to indicate.
- The Settings panel is always present. Its row does not change while
  vaults are away.

This follows ADR 0130's rule against claiming undetectability.

### 5. A vault that left is not listed by its siblings

Each tomb seals its own view of the project list, and that view includes
siblings' names. Until now, unlocking a vault listed whatever its view
remembered. So a vault deleted or departed while its sibling was locked came
back as a ghost row, name included. `hydrateProjectsFromVfs` now builds the
list from the vaults actually on the device: registered tombs, the active
pointer, and vaults still under pre-tomb legacy keys. Names come from the
sealed view. A stale sibling's name is **scrubbed** from the sealed view the
next time that tomb is unlocked. The open tomb's view is rewritten at
departure.

### 6. Return puts back exactly what left, and nothing else

`openReturn` opens the bundle and previews each vault as `comes_home`,
`already_home` or `occupied`. `completeReturn` restores what comes home: it
writes every file byte for byte, removes stray files of that tomb, and
registers the tomb again. It never overwrites a different vault sealed on
the road under the same id (`occupied`, usually a personal vault the
traveller sealed on the trip). Returning the same bundle twice is harmless.

A bundle is **hostile input**. Every file it carries must sit in the
namespace of the vault it claims (`foreign_file` otherwise). A bundle can put
a vault back but can never write the tomb registry, the guest switch, the
duress fence, settings, or another vault's files.

### 7. Composition

- **Duress (ADR 0130).** Departure and return both refuse while a duress
  incident holds the device, or after it has been retired (`duress_active`).
  Travel changes what is on the device before a trip; duress responds during
  one. They compose and do not merge.
- **Storage.** Travel mode refuses where nothing written survives the tab
  (`storage_not_durable`). It needs an origin file system that can list its
  files.
- **Capabilities.** `vaults.travel` is owned by the core `vault.local-unlock`
  capability. It has no egress and asks for no browser permission. Its PWA
  surface is `lib/travel/index.ts:packTravelDeparture`. MCP and WebMCP are
  excluded by this ADR: moving tombs and holding return codes is the
  traveller's decision, never an agent's (ADR 0065).

## Consequences and honest limits

- **Application-scoped removal, not a forensic wipe.** The receipt's
  assurance is `application_scoped_removal`. Deleting an OPFS file is not
  disk sanitisation.
- **Other copies are outside this device's control.** Any of these still
  holds the departed vaults and should be considered before a trip: a git
  backup target's history, Host sync, an Identity-plane project membership,
  an exported file, an OS-level backup of the browser profile.
- **Carrying the code defeats the design.** So does carrying the bundle
  together with the code. The panel says both must stay behind.
- **Stale names in other locked vaults.** A travel-safe vault with its own
  key that was locked at departure keeps a sibling's name sealed in its view
  until its next unlock. It is sealed under that vault's key, and the app
  never lists it.
- **No remote or timed lock yet.** A Host-held return code released after a
  date, or a custodian quorum, would add an independent authority (ADR 0130's
  third class). A client-side timer would not: local clocks are not tamper
  clocks (ADR 0130 INV-19). Both are left for a later ADR.

## Alternatives considered

- **Hide the vaults, keep the data.** Rejected. A compelled unlock with the
  app's own code, or a forensic reader, would still reach them.
- **A server-held switch, as 1Password does.** There is no server
  (ADR 0090). A Host could hold the code later, as an addition.
- **Delete without a bundle.** Rejected. Travel would then be a loss.
- **Reuse the duress limited-carry compartment.** Limited carry copies items
  into a new compartment inside a live session. Travel moves whole tombs
  while the device is at rest, with no key in memory, and must round-trip
  byte for byte.
