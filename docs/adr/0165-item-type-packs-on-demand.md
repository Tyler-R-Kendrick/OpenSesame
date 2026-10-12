# ADR 0165 — Built-in item types are packs: switched on, then downloaded

- **Status:** Accepted — implemented
- **Date:** 2026-10-04
- **Implementation:** the counts in the body ("18" packs, "23" definitions) are
  those of 2026-10-04. `marketplace/item-types/builtin/` now holds 28
  definitions: 5 embedded (`secret`, `file`, `passkey`, `certificate`,
  `drop`) and 23 packs (`packages/vault-item-types/src/packs/*.generated.ts`,
  indexed by `PACK_INDEX`).
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0087 ([vault item types are plugins](0087-vault-item-type-plugins.md)),
  ADR 0153 ([minimal PWA](0153-minimal-pwa-optional-sections.md)),
  ADR 0134 ([item-type marketplaces and Settings files](0134-item-type-marketplaces-and-settings-files.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md))

## Context

ADR 0153 made the minimal vault create a secret and a file, and put every other
built-in type behind capability switches. Two things were still wrong for the
person who runs a minimal installation:

1. **There was no way to choose a type.** Settings › Vaults › Item types was a
   file browser — `Installed` and `Marketplace` tabs, an unlabelled **+**, a
   folded `builtin/ 23` — and Settings › Capabilities offered three coarse
   switches (derived types, passkeys, certificates). Neither said "Wi-Fi: on".
2. **Off did not mean absent.** All 23 definitions were embedded in the entry
   bundle (about 44 KB of JSON) whether or not any was switched on.

## Decision

### 1. Core and packs

Five types stay embedded: `secret`, `file`, and the three a capability of its
own owns (`passkey`, `certificate`, `drop`). Every other built-in — 18 today —
is a **pack**.

`packages/vault-item-types/scripts/emit-definitions.mjs` splits the one corpus
(`marketplace/item-types/builtin/*.json`, still embedded whole by
`crates/vault-item-types`) into:

- `definitions.generated.ts` — the core text only;
- `packs.generated.ts` — `PACK_INDEX` (id, title, plural, extension, summary,
  categories, version, field count, byte size, SHA-256: enough to draw a row and
  say what switching it on costs) and `PACK_LOADERS`, one dynamic `import()` per
  pack;
- `packs/<id>.generated.ts` — one module per pack holding its text.

The bundler therefore emits each pack as its own chunk, reached only through a
dynamic import. Nothing of a pack — not its text, not its parse — is in the
entry bundle or fetched until its switch is on.

### 2. A pack is still a platform definition

`verifyPackText` checks the fetched text against the index's SHA-256, then runs
the same `parseDefinition(text, "platform")` as the embedded corpus, so a pack
may name a handler exactly as a built-in may, and a chunk that is not the one
this build indexed is refused. `registerPack` makes it real for the document;
`ItemTypeRegistry` rebuilds from `builtinRegistry()` when `packsVersion()`
moves, so a pack switched on or off needs no reload and no plan change.

A pack that is off **still owns** its id, title, directory and extension in the
registry's checks: a community type cannot take `wifi`, `.wifi` or "Wi-Fi
network" while the pack is off and then collide when it is switched on.
`isBuiltin(id)` is true for a pack id.

### 3. Switching on is the cue to download and install

`packages/app-core/src/lib/type-packs/` is the journey:

```
off → queued → downloading → installing → on
                    ↘ failed ↙ (the switch, pressed again, retries)
```

- **Downloads a few ahead, installs one at a time.** Fetching waits on the
  network and not on the main thread, so up to six downloads are in the air
  and the wall time of "switch on all" is the slowest chunk, not the sum; the
  digest, parse, sealed copy and registration are strictly one pack at a time.
- **The main thread is handed back** before each step and between packs
  (`scheduler.yield()`, else a macrotask). Fetch and the digest (`crypto.subtle`)
  are asynchronous; parsing is a few milliseconds. Taps, scrolling and typing
  keep up while eighteen definitions arrive.
- **No reload.** The capability switches commit with a consent receipt and
  reload the page; packs do neither. A pack is first-party same-origin code and
  data, not a capability with egress.
- **Persisted and offline.** The verified text is kept with its digest, sealed
  at rest (ADR 0149), under `item-type-packs.v1`, hydrated with the core boot
  keys. `restorePacks()` runs at boot, before first paint, and registers each
  from that copy with no request; a copy whose digest is not the build's is
  fetched again, never trusted.
- **Switching off** cancels a pack on its way or drops an installed one and
  forgets its copy. A type the open vault holds items of cannot be dropped:
  its items would lose their form (ADR 0158 — the setting is not removable
  while something depends on it).
- **A vault's own types stay available.** `watchVaultTypes` counts the pack
  types the open vault holds items of and installs them for this document,
  without recording a choice, so locking never leaves a switch the person did
  not press.

### 4. Notifications

State is the store (`state.ts`), not a spinner a component owns, and is told
three ways:

- the row — a spinner glyph while busy, a `StatusMark` on failure, the switch
  itself, with `aria-busy`;
- a polite live region in the panel (`Login installed.`, `Login did not
  install: Offline.`);
- the bell tray (`announce.ts`): one `type-packs` notice that follows a whole
  run in place ("Installing item types · 3 of 18"), then clears itself; a pack
  that failed keeps its own notice with a retry.

### 5. The screen

Settings › Vaults › Item types is a list of switches (`PackList`, `PackRow`),
designed for a thumb: the **whole row is the switch** (`role="switch"`, at least
3.5rem tall), grouped by what the types are for, with a search field that
narrows by any word of the title, extension or summary. The head says `n of 18
on`, shows the pending count, and carries one key to the marketplaces. Types a
person wrote or took from a marketplace sit beneath as files (ADR 0134); the
`Installed`/`Marketplace` tabs and the `builtin/` fold are gone. A built-in
Settings file for a pack exists only while the pack is on.

A type has no switch when pressing it would be wrong, and says why in place of
one: the vault holds items of it (their count), or a capability put it on (a
mark; the capability's own switch is the one to press).

### 6. Creation surface

`itemKindsFrom` adds the packs that are on to the capabilities' `item-kind`
contributions, deduplicated, at the rail positions the same kinds have when a
capability contributes them. `vault.derived-records` registers its 18 kinds at once from the index — nothing
in `activate` waits on the network, because a plan that is slow to settle
delays every capability behind it — and queues the 18 definitions behind them,
installed for the document and not remembered as a choice, so the coarse
capability still means "all of them".

## Consequences

- The entry bundle no longer carries 18 definitions (44 KB → 8 KB embedded,
  plus a 7.7 KB index); a pack is a separate hashed chunk.
- A definition change is a corpus change: re-run
  `pnpm --filter @opensesame/vault-item-types generate`. The drift test fails
  on any stale output, and on a pack present in both core and index.
- Test suites that assume the whole corpus load every pack in their setup; a
  suite about packs drops them first.
- `settings/item-types/builtin/<id>.json` no longer lists every built-in.
