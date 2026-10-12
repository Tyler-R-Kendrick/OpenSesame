# @opensesame/vault-item-types

Vault item types for the Client plane. A type is a manifest, never a code
path: this package holds the closed field-type catalogue, the one parser that
validates a definition, the runtime registry that loads built-in and installed
definitions alike, the projection onto a native secret, and the built-in
corpus itself, read from
[`marketplace/item-types/builtin/`](../../marketplace/item-types/builtin): five
core types embedded in the entry bundle and the other 23 as packs that arrive
on demand ([ADR 0165](../../docs/adr/0165-item-type-packs-on-demand.md)).

## Where it fits

- **Used by:** [`packages/vault-core`](../vault-core) (the device registry in `item-types.ts`), [`packages/app-core`](../app-core) (marketplaces and Settings files), [`apps/pages`](../../apps/pages).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) only.
- The host plane mirrors it in [`crates/vault-item-types`](../../crates/vault-item-types), which embeds the same JSON files with `include_str!`. One corpus, two parsers.
- The core types are `certificate`, `drop`, `file`, `passkey` and `secret` (`CORE_IDS` in `scripts/emit-definitions.mjs`). Every other built-in is a pack: `PACK_INDEX` (metadata and a SHA-256) is always present, and the definition text lives in `src/packs/<id>.generated.ts`, its own chunk behind a dynamic `import()`. Nothing is fetched, parsed or registered until a person switches the type on, and a chunk whose digest differs from the index is refused. Never import `src/packs/*.generated.ts` statically.
- A built-in's only privileges are a reserved id and the right to name a ceremony handler (`isPlatformPublished`). Otherwise it goes through the same parser as a definition a user installs at runtime, or one read from a marketplace.
- The parser refuses unknown keys at every level, a default value on a concealed field, a concealed field in any surface that renders without a reveal gesture, and a handler named by anyone but the platform.
- Uninstalling a type never touches items: an item of an unknown type is a presentation gap, not data loss.

## Surface

| Module | Exports |
|---|---|
| `catalogue.ts` | `FIELD_TYPES`, `FIELD_TYPE_IDS`, `fieldTypeSpec`, `isConcealedFieldType` — the closed field-type catalogue |
| `schema.ts` | `ItemTypeDefinition` and its parts, `HANDLER_IDS`, `CXF_CREDENTIAL_IDS`, size limits (`MAX_DEFINITION_BYTES`, `MAX_FIELDS`, …) |
| `validate.ts` | `parseDefinition`, `parseDefinitionValue`, `describeErrors`, `definitionToJson`; `DefinitionError` |
| `registry.ts` | `ItemTypeRegistry` (`install`, `check`, `uninstall`, `get`, `has`, `list`, `installed`, `categories`), `RESERVED_TYPE_IDS`, `compareVersions` |
| `native.ts` | `toNativeEntry`, `renderNativeEntry`, `fromNativeEntry` — the projection onto a native secret and trailer |
| `values.ts` | `emptyValues`, `displayText`, `subtitleFor`, `searchTextFor`, `missingRequired`, `pruneValues` |
| `builtin.ts` | `builtinRegistry`, `builtinDefinitions` (the core types plus whichever packs are loaded), `CORE_TYPE_IDS`, `BUILTIN_TYPE_IDS` (core and pack ids), `LEGACY_TYPE_IDS` |
| `packs.ts`, `packs.generated.ts` | `packEntries`, `packEntry`, `isPackId`, `loadPack`, `verifyPackText`, `registerPack`, `dropPack`, `loadedPacks`, `PackError`; `PACK_INDEX` and `PACK_LOADERS` are generated |
| `legacy-aliases.ts` | `LEGACY_TYPE_ALIASES` / `LEGACY_EXTENSION_ALIASES` (`login` → `account`, `.login` → `.account`, ADR 0172), `resolveTypeId`, `resolveExtension`; the registry resolves them in `get`/`has`/`sourceOf`/`isBuiltin` and refuses an install that takes either. Same table as `crates/vault-item-types/src/legacy.rs`, read back from `spec/conformance/item-type-cases.json` |
| `definitions.generated.ts` | `BUILTIN_DEFINITION_JSON` — the five core definitions; generated, do not edit |

## Develop

```bash
pnpm --filter @opensesame/vault-item-types test
pnpm --filter @opensesame/vault-item-types typecheck
pnpm --filter @opensesame/vault-item-types generate   # rewrite src/definitions.generated.ts, src/packs.generated.ts and src/packs/
```

Adding or changing a built-in type is a JSON edit under
`marketplace/item-types/builtin/` followed by `generate`. A test in
`src/registry.test.ts` fails if a generated module has drifted from the
JSON, so an edit without regenerating cannot merge. Optional types in
`marketplace/item-types/optional/` are not embedded; they are listed and
SHA-256-pinned in `.opensesame/marketplace.json`
(`node scripts/release/pin-marketplace.mjs`).

The rejection table and the native-projection cases are data, shared with
`crates/vault-item-types`: add a row to
[`spec/conformance/item-type-cases.json`](../../spec/conformance/item-type-cases.json)
and `src/conformance.test.ts` here and `crates/vault-item-types/tests/conformance.rs` there both run
it (ADR 0139). Only what cannot be a row — the size cap, malformed text, loops
over the whole corpus — stays as code in `validate.test.ts` and
`native.test.ts`.

## Related

- [ADR 0087](../../docs/adr/0087-vault-item-type-plugins.md) — vault item type plugins
- [ADR 0165](../../docs/adr/0165-item-type-packs-on-demand.md) — item-type packs on demand
- [ADR 0134](../../docs/adr/0134-item-type-marketplaces-and-settings-files.md) — item-type marketplaces
- [Vault item types design](../../docs/design/vault-item-types.md)
