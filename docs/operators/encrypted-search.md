# Encrypted search

Settings › Capabilities › **Encrypted search** (`storage.encrypted-search`,
[ADR 0173](../adr/0173-searchable-encryption-over-indexeddb.md)). Off by
default.

With it on, the IndexedDB databases this browser keeps for identifiers - the
history-backup accounts and snapshots, and the retired-password digests - are
encrypted databases: no database, table, field, key, id, vault name or user id
is readable in the browser's storage, and a lookup by one of them still does
not open every record.

## What switching it on does

1. The stores that hold those records are pointed at encrypted databases.
2. Whatever the device-sealed databases held (`opensesame-history-backups`,
   `opensesame-password-history`) is opened, written into the encrypted ones
   and the old databases are **deleted** - their names and the ids and scopes
   they kept readable go with them. A row is never reported missing while this
   runs: reads wait for it.
3. Nothing is searchable yet. A field gains an index only when a lookup first
   needs it, and loses it when it is dropped.

## What switching it off does

The stores go back to the device-sealed databases. The encrypted ones stay,
unreadable without the device key, until **Reset this browser** removes them.
Rows written while it was off are moved in the next time it is on; rows
written while it was on are not visible while it is off.

## How to tell it worked

In the browser's developer tools, Application › IndexedDB:

- there is no `opensesame-history-backups` or `opensesame-password-history`;
- there is `opensesame-edb-<32 hex>` for each, each with one object store `r`
  and one index `x`;
- every record is `{ c: "osr2.…", x: […] }`: a sealed row and its index
  entries. Nothing in it names a table, a field or a person.

`opensesame-at-rest` (the device key store) is the one other database. It holds
a non-extractable key and the data key wrapped under it, and it must open
before any key is known, so its two fixed names stay.

## What it does not do

- It protects the databases from someone who reads the browser profile's
  files. It does not protect them from script running in the page, which has
  the key, and it does not hide which index entries a lookup touches from a
  debugger watching IndexedDB.
- The key is the device's at-rest key, not the vault's password or passkey.
  See ADR 0149.
- The databases are this browser's. They do not sync.
- What an index leaks once built: equality (which rows share a value),
  keyword (which share a word), order (the order of a column's values).
  ADR 0173 §6 has the table.

## For a developer: using the library

```ts
import {
  defineSchema,
  openEncryptedDb,
} from "@opensesame/app-core/lib/encrypted-db/index.js";

const schema = defineSchema({
  receipts: {
    key: "id", // a non-empty string field
    columns: {
      // `group` lets another table's column share tokens: find an id across both
      userId: { eq: { group: "principal" } },
      action: { eq: true },
      at: { order: { type: "time" } }, // ISO strings or epoch ms
      amount: { order: { type: "int", min: 0, max: 1_000_000 } },
      note: { keyword: { prefix: 3 } }, // words, and prefixes of 3+ characters
    },
  },
});

const db = await openEncryptedDb("receipts", schema); // the name is hashed on disk
await db.put("receipts", { id: "r1", userId: "u1", action: "approve", at: "2026-01-01T00:00:00Z", amount: 5, note: "vault review" });

await db.get("receipts", "r1");
await db.find("receipts", { userId: "u1" });
await db.find("receipts", { at: { gte: "2026-01-01T00:00:00Z" } }, { order: { column: "at", direction: "desc" }, limit: 20 });
await db.find("receipts", { note: { word: "vault" } });
await db.find("receipts", { note: { prefix: "rev" } });
await db.count("receipts", { action: "approve" });
await db.drop("receipts", "action", "eq"); // remove the layer and every entry it left
db.close();
```

- A column is searchable only through the layers its schema declares; a
  predicate on one that has none is an error.
- A layer is built on the first query that needs it, or at open if the column
  says `eager: true`; `build` and `drop` do it by hand. Building re-indexes
  every row without re-sealing it, in 64-row transactions.
- An `order` column rejects, at write time, a value outside its domain.
- `openEncryptedDb` throws `EncryptedDbUnavailable` where the device has no
  durable key or no IndexedDB. Callers that can keep a row in memory for the
  document (the two stores here do) should; none should fall back to a
  readable store.
- Open per operation and `close()`: an open connection blocks Reset this
  browser from deleting the database. `withEncryptedDb` does this.
- Add a new database's logical name to `EDB_LOGICAL_NAMES`
  (`lib/encrypted-db/names.ts`) so Reset can derive its name where the browser
  cannot list databases.
