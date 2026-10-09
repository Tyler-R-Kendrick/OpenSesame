# ADR 0171 — Hide items while traveling

- Status: Accepted
- Date: 2026-10-05
- Implementation: the Travel panel (the vault departure and "Leave items at
  home") is drawn in Settings › Security, beside the duress row
  (`SecurityPanels` in `apps/pages/src/sections/SettingsSection.tsx`), not
  under Settings › Vaults as §1 says.
- Amends: [ADR 0143](0143-travel-mode.md) (travel gains a second,
  per-item granularity; the vault departure there is unchanged)
- Builds on: [ADR 0063](0063-encrypted-vfs-tombs.md) (the open body is
  sealed under the vault key), [ADR 0130](0130-duress-profiles-trust-boundaries.md)
  (the duress gate; no claim of undetectability),
  [ADR 0144](0144-tailnet-vault-sync.md) (a merge is a union),
  [ADR 0149](0149-nothing-stored-in-the-clear.md),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md)
- Research: [`docs/research/travel-hidden-items.md`](../research/travel-hidden-items.md)
  (the audit this decision rests on)

## Context

A person compelled to unlock at a border can still open the vault they carry
with the real key. ADR 0143 moves whole vaults and works with no key in
memory, so it cannot help here: the vault that is opened is the one that
stays. The owner needs to choose, item by item, what is **not** in the vault
that opens. 1Password's Travel Mode is also vault-level, so this goes beyond
it.

Taking an item out of `VaultBody.items` is only hiding if nothing the owner's
key opens still holds it. The audit lists 25 places an item's content or name
can persist. A normal removal (trash, then purge) fails the requirement three
ways: trash keeps the item, a purge writes a tombstone that would **delete**
the item on the owner's other devices, and the activity log keeps a line with
the item's name.

## Decision

### 1. A different act from a vault's departure

"Leave items at home" works on the **open** vault: the owner is present and
the key is in memory. It lives beside ADR 0143's two ceremonies in Settings ›
Vaults › Travel, and uses the same code, the same return code format and the
same gates.

### 2. An items bundle

`opensesame.travel-items`, v1 (`lib/travel/items-bundle.ts`): the vault
bundle's family (AES-256-GCM; HKDF-SHA-256 from the 144-bit return code salted
with the bundle id; the format, version and id bound as AAD) under its own
tag, so a vault bundle can never open as an items bundle or the reverse.
Outside the seal: tag, version and a random id. Inside: each item whole (its
own id, times, folder assignment, trash state), the folders those items
named, and `{tomb, createdAt}` of the vault they left.

### 3. Two steps, and a silent removal

`packItemDeparture` writes nothing. It seals the chosen items and proves the
displayed code opens the bundle and the bundle holds what was read.
`completeItemDeparture` runs only after the owner says the bundle is stored
elsewhere, the code is recorded, and (in the sheet) that copies elsewhere
remain. It then:

1. checks the gates, the shares and the copies again;
2. drops the traces the device keeps beside the vault (activity lines whose
   `targetId` is a hidden id, retired-password digests, the offline
   ciphertext cache);
3. removes the items in **one** sealed mutation from the body the disk holds
   (`VaultStore.withdrawItems`, `lib/vault/item-departure.ts`). The mutation
   compares every item with the text that was packed and refuses the whole
   change if any differs. It writes **no tombstone, no trash entry, no
   activity line**. A folder only hidden items sat in leaves with them;
4. drops the traces again, since a line may have been in flight.

A purge that fails before the removal stops it with nothing taken
(`purge_failed`). One that fails after reports `incomplete`, and pressing the
key again with the same package finishes it: the items are already gone, the
purge repeats.

### 4. Return

`returnItems` needs the vault open and the code. It refuses a bundle that is
not an items bundle, a wrong code or typo, a tampered bundle, another vault's
bundle (`other_vault`) and an id the vault holds with different content
(`occupied`); each changes nothing. It re-adds the items under their own ids,
times, folders and trash state in one mutation (`VaultStore.restoreWithdrawn`),
recreating a missing folder under its own id, and writes no activity line.
Returning twice is a no-op. A tombstone for an id being brought back by hand
is dropped with it.

### 5. Refuse beside what cannot be made safe

Hiding does not run, and says which, when any of these is in play:

- **a backup target** is enabled, or a history remote is bound: the remote
  keeps every older revision, which this device cannot rewrite
  (`backup_target`, `history_snapshot`);
- **a paired drive** is configured: `mergeVaultBodies` is a union, so the next
  sync (on unlock, after each change, every minute) brings an item that is
  missing here back from a device that has it (`paired_drive`). A test shows
  the resurrection;
- **a held history snapshot** (`history_snapshot`) or a **queued offline
  write** (`offline_queue`) exists;
- the item has a **live share** or a session grant (`item_shared`);
- the item **cannot leave whole**: it holds a file whose parts live outside
  the vault, or it is a drop (`item_not_hideable`; such items are not offered).

### 6. No ledger on the device

Nothing records which ids or titles are hidden, and the choice is not
remembered (unlike ADR 0143's "safe for travel" marks). A ledger is the
device saying that something was hidden, which a person at a border cannot be
made to show without it. So:

- the **Return** row (the existing "Come home from a trip") is always drawn
  and never lists anything. The titles appear only in the sheet's preview,
  after the bundle and code open it;
- the Leave row names only a count of items that could leave;
- Settings is files (ADR 0134), but there is no file here to view: a file of
  hidden items is the ledger.

The cost is stated: a later merge cannot know to leave an item out. That is
why §5 refuses beside any surface that merges.

### 7. Gates, as travel today

Refuse while a duress incident holds the device (`duress_active`), without
durable storage (`storage_not_durable`), and when the owner is not present
(`owner_not_present`: a guest or decoy session is never the owner). The same
cross-tab Web Lock (`opensesame.travel`) as ADR 0143 serialises it. The guest
and decoy tombs are never touched.

### 8. Capability

`vaults.travel_items` (`packages/capability-registry/src/vault-travel.ts`),
owned by the core `vault.local-unlock` capability like `vaults.travel`; no new
optional capability. MCP and WebMCP are excluded, with the same reason as
ADR 0143: what stays on a coerced person's device is that person's decision,
and an agent that could choose it could also undo it.

## The audit, in short

Full table in the research note. By action:

| Action | Surfaces |
|---|---|
| Removed by the mutation | live items, trashed items, folders only they filled |
| Suppressed (the removal writes none) | tombstones, trash copy, activity line for the removal |
| Purged | activity lines about the item, retired-password digests, offline ciphertext cache |
| Refused | backup target, history remote or snapshot, paired drive, queued offline write, a share, files, drops |
| Not applicable | item history (the model keeps none), search index and recents (not persisted), bell and notices (in-tab), access audit (connections only) |
| Stated limit | other devices, exports, backups the owner made, duress compartments, disk remanence, ids kept by connector bindings, another open tab until reload, an import of an older export |

## Consequences and honest limits

- **Application-scoped removal, not a forensic wipe**, as ADR 0143. The
  receipt's assurance is `application_scoped_removal`. The browser may keep
  older blocks of the sealed body on disk.
- **Copies elsewhere stay.** Other devices, exports and offline backups the
  owner made, Host sync and Identity memberships still hold the items. The
  consent in the sheet says so.
- **The owner holds the only copy locally.** Losing the bundle and the code
  loses the items. The sheet says so.
- **It is not protection from coercion.** A person may be made to say items
  are hidden, or to give up the bundle and the code. Nothing here claims
  undetectability (ADR 0143 §4, ADR 0130): the Leave and Return rows do not
  change whether items are away, but a person who is shown the app's
  Settings can see that the feature exists.
- **A merge or a restore the owner does later can bring them back**: an
  import of an older export, or a drive paired after the trip, is the
  owner's own act and cannot be suppressed without a ledger (§6).
- **Retired-password reuse protection restarts** for a returned item.
- A connector bound to a hidden item (a GitHub App's secret item, a wallet
  instrument) stops working until the item returns; only its id is kept.
- A **trace purge that cannot reach IndexedDB** (the browser refusing it) is
  swallowed by that store and cannot be told apart from success. It holds
  digests only, sealed under the device key.

## Alternatives considered

- **A hidden flag on the item.** Rejected: the content stays in the body, a
  compelled unlock or a forensic reader of the body reaches it.
- **Reuse the duress limited-carry compartment.** Rejected, as in ADR 0143: it
  copies into a live compartment and leaves the source's history.
- **Keep a list of what is hidden** so Return could be a switch per item.
  Rejected (§6).
- **Bundle files with their parts.** Rejected here: parts can be a gigabyte
  and the bundle is held in memory. Such items are not offered.
- **Suppress a merge's resurrection** by holding hidden ids in the body.
  Rejected (§6); refuse beside the merge instead.
