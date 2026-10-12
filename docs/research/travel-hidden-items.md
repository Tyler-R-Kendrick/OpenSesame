# Hiding items while traveling: what an item leaves behind

Audit for [ADR 0171](../adr/0171-hide-items-while-traveling.md). It extends
[`travel-mode.md`](travel-mode.md), which covers whole vaults.

## The requirement

A person compelled to unlock at a border opens the vault they carry with the
real key and sees it **without** the items they chose to leave home. That is
different from [ADR 0143](../adr/0143-travel-mode.md), where a vault leaves
whole and nothing is open. 1Password's Travel Mode is also vault-level.

Taking an item out of `VaultBody.items` is "hiding" only if the item's content
is not left reachable from the app the person is made to use, or from the
vault's own copies. So before building, this audit lists every place an item's
name, fields or secret can persist or surface once it has left the body, and
says what a normal removal does there today.

How it was done: reading the vault store (`lib/vault/store.ts`, every
`#mutate` caller), `vault-core` (`model.ts`, `merge.ts`, `sync-model.ts`), every
sealed file a tomb writes (`config/*`), the IndexedDB stores, the kv records
named for a vault, and the Pages vault screens. Then, for each surface, a
test walk with real crypto (see "How the audit is held").

## What a normal removal does today

`trashItem` stamps `deletedAt` and keeps the whole item in `body.items`.
`purgeItem` and `emptyTrash` drop the item and write a tombstone
(`VaultTombstones.items[id] = time`) so that another device's merge cannot
bring it back. `saveItem` writes an activity line naming the item. Both are
the right behaviour for deleting. For hiding they are exactly wrong: trash
keeps the item, and a tombstone, when it syncs, deletes the item on the
owner's other devices.

## Audit table

"Today" is what a normal removal (trash then purge) leaves. "Action" is what
hiding does about it: **purge** (the trip removes it), **suppress** (the
removal is written so it never lands), **refuse** (hiding does not run while
the surface is in play), or **limit** (stated to the person, not handled).

| # | Surface | Today after a normal removal | Action |
|---|---------|------------------------------|--------|
| 1 | `body.items` (live) | Gone from the list. | Removed in one sealed mutation. |
| 2 | Trash (`deletedAt`, the same array) | A trashed item keeps its whole content until purged. | An item in trash can be hidden like any other; it leaves with its `deletedAt`. Nothing is copied to trash. |
| 3 | `body.tombstones.items` | A purge writes the id and the time. A tombstone is also a delete order on every other device. | **Suppress.** The silent removal writes none. Return drops a tombstone for an id it is bringing back. |
| 4 | `body.folders` | Folder names stay, and name what was in them. | A folder that only hidden items sat in leaves with them (bundled, no tombstone). A folder that was already empty is left alone. |
| 5 | Item history, versions, "recently changed" | The vault model keeps none: an item is one object, edits overwrite it. | Nothing to purge. Verified: no history field exists on `VaultItem`. |
| 6 | Activity log (`config/activity-log`, sealed under the vault key) | `vault.<kind>.created` / `.updated` lines name the item (`summary`) and carry its id (`targetId`) for up to 500 lines. A purge does not touch them. | **Purge.** `forgetActivityAbout` drops every line whose `targetId` is a hidden id, before the removal and again after it. The removal and the return themselves write no item line. The generic "Vault body saved" line that any write makes stays: it names nothing. |
| 7 | Password reuse digests (IndexedDB `opensesame-password-history`, or the encrypted database that replaces it under ADR 0175; sealed under the device key) | A retired password's SHA-256 is kept by `tomb + itemId`, so a hidden item stays recognisable by its old passwords. | **Purge.** `forgetRetiredPasswords` by scope. A digest is not a password, but it is a way to confirm one. Returned items forget their old passwords, so reuse protection restarts for them. The purge matches the scope `tomb + itemId` exactly: an account's second password method, or a credential bound to one, keeps its digests under `tomb + accountId + methodId`, which it does not reach. |
| 8 | Search index, recents, selection, drafts | Not persisted. Search is computed from `items` on each render; `login-draft` and `new-draft` are in memory. | Nothing to purge. Held by the DOM test, and by the journey: search for a hidden title finds nothing, after reload. |
| 9 | Bell tray and notices | In-tab and never written (`notices.ts`). Device receipts and local notifications carry only `{kind, action, ref}`. | Nothing persisted. Another open tab keeps what it showed until reload (limit, row 24). |
| 10 | Older sealed revisions (history-backup IndexedDB, `appendHistoryEntry`) | Hold whole sealed bodies the owner's key opens. | **Refuse.** Nothing in the app writes there today, but a snapshot is an older body with the items in it that no purge here can rewrite. Hiding refuses if any exists (`history_snapshot`). |
| 11 | Backup targets (git remote, local target) and history remotes | Every vault write pushes a sealed snapshot, and the remote keeps every older one. | **Refuse** while an enabled target or a bound history remote exists (`backup_target`, `history_snapshot`). The remote's copies cannot be rewritten from here. |
| 12 | Paired drive (`config/tailnet-drive`, ADR 0144) | A merge runs on unlock, after each change and every minute. `mergeVaultBodies` is a union: an item missing here and present there comes **back**. | **Refuse** while the vault is paired (`paired_drive`). The test `brings them back through a merge` shows the resurrection. This is the surface that would make the feature lie. |
| 13 | Offline ciphertext cache (`vault.offline-ciphertext.v1:*`) and queued writes (`vault.offline-mutations.v1`) | A last sealed copy of the whole vault, and queued whole-vault snapshots. | The cache is a copy and is **purged** with the trip. A queued write is **refused** (`offline_queue`), since dropping it would lose a pending sync. Nothing writes either today. |
| 14 | Item shares and Access sessions (`config/identity-shares`, `config/vault-sessions`) | `resourceLabel` is the item's name; the grant outlives the item. | **Refuse** for an item with a live share or a session grant (`item_shared`). Revoke first. |
| 15 | Access audit (`config/access-audit`) | Connector grants only. No item is named. | Nothing to purge. |
| 16 | Files and their parts (OPFS directory `opensesame-pages-file-parts`) | A `blob` field holds a manifest; ciphertext sits in parts outside the vault. | **Refuse** the item (`item_not_hideable`; not offered). A bundle carrying up to a gigabyte of parts was out of scope, and leaving parts behind would leave their size and count. |
| 17 | Drops (`kind: "drop"`) | A claim in flight, with a bearer token and its own claim record. | **Refuse** the item. |
| 18 | Passkey, TOTP, connector references that name an item id (`github-app-secret` binding, `wallet-assignments`, tree collapse `dir_<folderId>`) | The id stays. | **Limit.** An id alone discloses no content and is inert once the item is gone. A connector bound to a hidden item stops working until the item returns. |
| 19 | Duress compartments (limited carry copies) | An independent keyed copy of chosen items. | **Limit.** It is the duress feature's own copy and is not touched; hiding refuses while duress holds the device. |
| 20 | Exports and offline backup files the owner made | Outside the device. | **Limit.** Stated in the sheet. |
| 21 | Other devices, Host sync, Identity memberships | Hold their own copies. | **Limit.** Stated. A device paired through the drive or a backup refuses (rows 11 and 12). |
| 22 | The sealed body's own history on disk | OPFS overwrites a file; the browser may keep older blocks. | **Limit.** Application-scoped removal, not a forensic wipe (as ADR 0143). |
| 23 | An import or restore of an older export (`importSealed`) or a snapshot merge another way | Brings the items back. | **Limit.** A person's own act, with their own file. |
| 24 | Another tab of the same vault | Its in-memory list keeps the item until it reloads or writes; a write starts from the disk's body, so it does not bring the item back. | **Limit.** Stated. |
| 25 | The bundle and return code | Hold everything. | The person's: stored away from the device. Losing the bundle **and** the code loses the items. |

## What this means for the design

* Nothing needs a ledger on the device: not a list of hidden ids, not a title.
  A ledger would be a place that says something was hidden, which is the
  thing the person at a border cannot be made to show. So the **Return** row
  is always drawn and never lists anything; the items come from the bundle,
  after the code opens it. The choice of what to leave is not remembered
  either (unlike "Safe for travel" for vaults).
* Because there is no ledger, a later merge cannot know to leave an item out.
  So hiding refuses beside any surface that merges or keeps copies (rows 10 to
  14), and says which.
* Hiding runs on the open vault. It is not the vault's departure, which is
  unchanged.

## How the audit is held

`packages/app-core/src/lib/travel/travel-items-leak.test.ts` seeds a real
vault with a distinctive string in a name, a username, a password, a note, a
custom field, a TOTP seed, a trashed note, a folder name, and a login that was
edited (so it has a retired password and an "updated" line). It hides three
items, then looks for every string and every id in:

* the open store's items, folders and trash,
* the next sealed save's plaintext body, opened with the owner's key,
* every tomb file listed in the sealed index, opened with the key,
* every origin file as stored, and the plaintext records named for the vault,
* the activity log,
* the retired-password digests,
* the tombstones,
* and again after a lock and a fresh unlock.

The same walk runs with the purge steps off and **must find** the activity
lines and the digests, and with an ordinary trash-then-purge and **must find**
the tombstone. Two cases refuse: a history snapshot holding an older revision,
and (as a documented limit) a merge with a snapshot taken earlier brings the
items back. Mutating the purge to a no-op fails the main test.

A real-browser journey (`J-TRAVEL-ITEMS`, `apps/pages/scripts/lib`) walks it
in Pages: hide two items in Settings, reload, lock, unlock, and look for the
titles and secrets in the page text, search, trash and the activity list; then
return with the code, and a wrong code.

## Not claimed

* Protection from coercion. A person may be made to say there are hidden
  items, or to give up the bundle and the code.
* Anything on another device, a remote, or an export.
* Removal from the browser's storage below the file layer.
