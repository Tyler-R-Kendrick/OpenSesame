# ADR 0173 — Searchable encryption over IndexedDB

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR 0149](0149-nothing-stored-in-the-clear.md) (the device key
  and the record seal), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (an optional feature is a capability that loads after consent),
  [ADR 0133](0133-shared-app-core.md) (ports, no browser global in the core),
  [ADR 0090](0090-static-frontend-complete-without-backend.md) (Pages needs no
  backend)
- Amends: ADR 0149 §3 for the stores below: their database, store and index
  names, their record ids and the fields their indexes used are no longer
  readable while the capability is on

## Context

ADR 0149 sealed every value the client writes. It left the *shape* of the
data readable. The two IndexedDB databases that hold identifiers still showed,
to anyone who reads the browser profile:

- the database, object-store and index names (`opensesame-password-history`,
  `digests`, `by_scope`; `opensesame-history-backups`, `entries`,
  `by_account`) - which say what the app keeps;
- each record's key and the field its index was built on: the retired-password
  store kept the **scope** - the vault's name and the item's id - beside every
  sealed digest, and the history store kept each snapshot's account id.

Those were readable on purpose: an index needs something to look up by, and
the usual way to make a lookup work is to leave the lookup field in the clear.
The ask is to have no database content readable - not a name, not a user id,
not a field - and still find a record by what is in it without opening all of
them. That is the problem [CryptDB](https://people.csail.mit.edu/nickolai/papers/raluca-cryptdb.pdf)
(Popa et al., SOSP 2011) solved for a server-side SQL database.

CryptDB's setting is different in one way that decides most of this design.
Its adversary is the database server, which runs queries over ciphertexts
for a client that holds the keys. Here the "database" is IndexedDB: it
computes nothing, the keys and the code are in the same document, and the
adversary is whoever reads the profile's storage files - an infostealer, a
forensic image, a synced or backed-up profile - not a process that watches
queries run. So: a CryptDB *design*, adapted to a store that can only compare
keys, with the leakage stated for that adversary.

## Decision

### 1. An optional capability, `storage.encrypted-search`

Off by default. Selecting it is consent (ADR 0130), after which the module
`apps/pages/src/modules/storage.encrypted-search` runs. It registers nothing
the person sees but its Settings › Capabilities section. What it does is
route two core stores through a seam:

| Store | Seam | Without the capability | With it |
|-------|------|------------------------|---------|
| History backups | `HistoryRowStore` (`history-backup-types.ts`) | `opensesame-history-backups`, ids and account ids readable | an encrypted database; nothing readable |
| Retired-password digests | `PasswordDigestStore` (`vault/password-history-types.ts`) | `opensesame-password-history`, scope readable | an encrypted database; nothing readable |

On activation it moves what the device-sealed databases hold across, opened
and re-written, and **deletes them** - the database, store and index names go
with the rows. Reads wait for the move, so a row written before the switch is
never reported missing. Turning the capability off routes the stores back; the
encrypted databases stay, unreadable without the device key, until Reset this
browser removes them. A row written while it was off is moved in on the next
activation.

The core stays small: it holds the seams and the sealed implementations; the
searchable library (`lib/encrypted-db/`) is imported only by the module, so
a build that leaves the capability out never loads it.

### 2. One store, one index, no names

An encrypted database is **one object store (`r`) with out-of-line keys and
one multi-entry index (`x`)**, whatever the application keeps in it. There is
no store per table and no index per column, because a store name and an index
name *are* names. A browser profile shows:

```
opensesame-edb-<128 bits>      the database, named by a keyed hash
  r  : <128-bit hex key> -> { c: "osr2.<sealed row>", x: [<entries>] }
  x  : the multi-entry index over x
```

and nothing else: not the table, the column, the key or the field.

- **Row key.** `HMAC(rowKey, ["row", table, key])`, 128 bits. A row is read
  by key in one lookup, opening nothing else.
- **Seal.** The table, the key and every field are inside it
  (`lib/encrypted-db/rows.ts`), under XChaCha20-Poly1305 with the record seal
  of ADR 0149, bound to the database and the row's slot: a record moved to
  another slot, or another database, opens as nothing.
- **Padding.** The plaintext is padded to a Padmé length (Nikitin et al., 2019:
  at most 12% over, few distinct sizes) and never to less than 256 bytes, so a
  short key and a long one occupy the same record.
- **Index entries.** Every searchable value becomes an entry in `x`: a
  128-bit hex string (an equality, word or prefix token) or a `[tag, hex]`
  pair (an order key). Entries of different columns and tables are
  indistinguishable by shape.
- **Database name.** `opensesame-edb-` and 128 bits of
  `HMAC(nameKey, logicalName)`. The prefix is what the ownership rule
  (`storage-ownership.ts`) recognises, so Reset this browser can find and
  delete it; without the key nothing links it to "history-backups".

Because the schema is code and not storage, adding a table or a column needs no
IndexedDB version change and is invisible on disk.

### 3. Key hierarchy

```
at-rest key (ADR 0149, 32 bytes, device)
 └─ master    HKDF("opensesame.edb.v1", "master")
     └─ database   HKDF("database", logicalName)
         ├─ seal     row seal key
         ├─ row      row-key and layer-state pseudonyms
         ├─ tag      a column's order-entry tag
         ├─ token    ("eq" | "kw" | "px", scope)   one key per kind and scope
         └─ ope      (table, column, domain)        one key per order column
```

A layer's key never opens another's. Nothing is stored; every key is derived
at open and zeroed at close. The root is the device key, so **the databases
are as strong as the device key and no stronger** - they are not protected by
the vault's password or passkey (see the residual risks below).

### 4. The onion, peeled on demand

CryptDB stores every column as nested layers - RND (probabilistic), then DET
(deterministic, equality), then OPE (order) - and *peels* a layer only when a
query needs it, so a column leaks nothing beyond what has been asked of it. A
client-side store cannot ask a server to peel, so the same principle runs in
the direction it can: the stored row is always the RND layer (the seal), and
**a searchable layer is built on the first query that needs it** and can be
dropped again.

| CryptDB layer | Here | Answers | Leaks at rest, once built |
|---------------|------|---------|---------------------------|
| RND | the row seal | nothing; opened by key | length to a Padmé bucket; the row count; entries per row |
| DET | `eq` - an HMAC token per value, per column (or per named group) | `=`, membership of an array column, `count` | which rows share a value in that column (frequency) |
| OPE | `order` - Boldyreva-style, integers or times (`ope.ts`) | `<`, `<=`, `>`, `>=`, ranges, `min`/`max`, ordered pages | the order of a column's values, and roughly the values where the domain is dense (Naveed, Kamara, Wright 2015) |
| SEARCH | `keyword` - whole-word tokens, and word-prefix tokens above a minimum length | words, every word of a phrase, prefixes | which rows share a word; which share a prefix |
| JOIN | an `eq` **group**: columns that name one share tokens | the same id across tables | which rows of the joined columns share a value |
| HOM | not built | - | - |

**HOM is deliberately absent.** Paillier sums let a server add ciphertexts for
a client that cannot. Here the client is the only party that computes, so it
decrypts and adds; a homomorphic layer would add a leak and a cost for
nothing.

How the lazy part works (`layers.ts`, `meta.ts`): the schema declares which
layers a column *may* have. Until a query asks, the column has none, and the
disk holds no entry for it. The first query records the layer as `building`
(from then on every write indexes it), re-indexes every row without
re-sealing, and records it `ready`. A tab that dies midway leaves `building`;
the next query finishes it. `drop` is the inverse and complete - every entry
for the layer is removed - which a server-side onion cannot do. A column may
say `eager`. The layer-state record is itself a sealed row, so which columns
have ever been searched is unreadable too.

A write validates every `order` column against its domain whether or not the
layer is built, so a layer built later cannot fail on rows already written.

### 5. Queries

`find(table, where, { order, limit })` compiles each predicate to an index
range and an exact test. It picks the predicate with the fewest entries
(`index.count`), opens only the rows that range names, and **tests every
predicate again on what it opened** - so a prefix longer than the longest
indexed one, a token a join group shares, or an exclusive bound can never put
a wrong row in an answer; the index only narrows. An ordered page walks the
order column's own range in either direction and opens `limit` rows. A
`count` that the index can answer exactly does not open a row.

`where` takes a value (equality), `{gt, gte, lt, lte}`, `{word}` or
`{prefix}`. A predicate on a column with no such layer is an error, not a
scan.

### 6. Adversary and what it sees

The adversary is **a reader of the browser profile's storage** (a disk image, a
copy of the profile, a synced or backed-up profile, malware that reads files).
It does not see queries, because they run in memory; it does not have the key.
It sees:

| Always | Once a layer is built |
|--------|-----------------------|
| one database per logical store, its size, and the number of rows | equality: which rows of one column share a value |
| each row's length to a bucket, and how many index entries it has | keyword: which rows share a word or a prefix |
| when the database was last written (file times) | order: the order of that column's values |

It does not see a table, column, key, field, value, user id or name - not even
that a column exists - and it cannot tell which columns have been searched.

**Not covered.** A *live* attacker who can run script in the document or read
its memory has the key; this is not protection against that. An observer of
IndexedDB *operations* (a debugger) sees which index entries a query touches;
that is access-pattern leakage this design does not hide.

### 7. Residual plaintext, stated

With the capability on, nothing in the two databases above is readable. These
remain readable by design or by necessity:

- **`opensesame-at-rest/keys/device`**: the key store. It holds a
  non-extractable key and the data key wrapped under it; its names are fixed
  because it must open before any key is known. It is the one IndexedDB
  database that is not an encrypted database, and it holds no data of the app's.
- Origin-private file names (`opensesame-pages-*`) and Web Storage key names,
  whose *values* are sealed (ADR 0149). They are not IndexedDB and are out of
  scope here.
- The existence and size of the encrypted databases, and the file times.

### 8. Reset

The encrypted databases are named by hashes, so Reset this browser finds them
two ways: it lists them (`indexedDB.databases()`, where the browser has it;
Firefox does not before 126) and it derives the name of every logical database
the app opens from the device key - read only if it has already loaded, and
before the database that holds it is deleted. A reset must not mint a key.

### 9. Not changed

The vault itself (OPFS, sealed under the vault key), the key store, travel
mode, the backup targets and everything the device-sealed stores do with no
capability on. A device with no durable key (a browser that refuses
IndexedDB, a document whose key load timed out) opens no encrypted database
and keeps what it was writing in memory, for the document only - never in the
clear.

## Consequences

- **Cost.** An open derives a handful of keys and reads one sealed record; the
  stores open and close per operation, as the sealed ones did, so a reset is
  never blocked. An order value costs one HMAC per level of the
  recursion, about 2 ms measured under Node; building an order layer over ten
  thousand rows costs about twenty seconds of that, once, in 64-row
  transactions that yield between them. Equality and keyword layers cost one
  HMAC per entry.
- **The device-key tier.** The root is the at-rest key, not the vault key. A
  device whose profile *and* browser-held wrapping key are both taken opens
  these databases. They are not a place for anything the vault key alone
  should guard; they hold retired-password digests and history snapshots that
  were already sealed under the same key.
- **OPE is the weak layer.** It is built only for a column that declares
  `order` and only after a query asks. The two stores here declare none, and
  the implementation draws the hypergeometric split exactly for small domains
  and from its normal limit above 64 points, with integers only so no
  browser's `Math.log` can move a ciphertext; it is not a proof of the paper's
  ideal-OPF security and is documented as such.
- **Not synced.** The databases are this browser's. A second device builds its
  own.
- **Not built from CryptDB.** Multi-principal key chaining (a row readable only
  while its owner is signed in; CryptDB §4) - here there is one key per device,
  and giving a person's rows to another principal would be its own decision
  about whose key opens them. A SQL proxy and query rewriter - the schema is
  data and the query is the `where` above. `ADJ-JOIN`, the re-keying of one
  column to another's key - a group names the shared key up front, since a
  client that holds both keys never needs to re-key a server's copy.
- **Mixed windows.** While the capability is off, new rows rest in the
  device-sealed stores; they are moved the next time it is on. Rows written
  while it was on are not visible while it is off.

## Verification

- `lib/encrypted-db/*.test.ts`: order preservation (property tests over a
  2^48 domain), the on-disk layout (one store, one index, pseudonymous name,
  every record `osr2.`), a full sweep of the raw records for names, ids,
  fields and words, equal-sized records for unequal rows, layers dormant until
  asked and gone when dropped, moved rows opening as nothing, another device
  key opening nothing, equality, array, group, range, ordered-page, word and
  prefix queries, the migration and Reset (listed and derived).
- A run in real Chromium of the same library, bundled for the browser, over
  the real at-rest key store: 40 rows, every query above, and a sweep of every
  record of every database for the plaintext it must not hold.
