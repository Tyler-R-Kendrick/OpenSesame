# opensesame-vault-item-types

Vault item types on the host plane. A vault item type is a manifest, not a code
path: this crate holds the closed field-type catalogue, the definition parser
and its rejection table, the runtime registry, and the projection of any typed
item onto the base native secret (`sealed_store::Entry`, line one plus a
`key: value` trailer). The built-in definitions in
[`marketplace/item-types/builtin`](../../marketplace/item-types/builtin) are
embedded verbatim, so the host plane and the client plane cannot disagree about
what a type is.

## Where it fits

- **Used by:** no workspace crate or app depends on it today; `apps/cli`,
  `apps/pm-bridges` and `kdbx-bridge` read `sealed_store::Entry` directly and do
  not link this crate. It is exercised by its own tests
  ([`tests/conformance.rs`](tests/conformance.rs),
  [`tests/registry.rs`](tests/registry.rs)) and by the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`vault_item_type`, which runs
  `parse_definition` at community trust). It is not in the authority-fabric
  gate.
- **Builds on:** [`opensesame-sealed-store`](../sealed-store) (`Entry`).
- The TypeScript twin is [`@opensesame/vault-item-types`](../../packages/vault-item-types);
  `tests/conformance.rs` mirrors its `validate.test.ts` and `native.test.ts`, so
  a definition valid on one plane is valid on the other.
- Installing or uninstalling a type is a data write, never a build. Uninstalling
  never touches items: an item whose type is missing is a presentation gap, not
  data loss.

## Surface

| Area | Items |
|---|---|
| Corpus | `BUILTIN_DEFINITIONS` (23 embedded JSON files), `LEGACY_TYPE_IDS` (the seven ids that predate ADR 0087) |
| Catalogue | `FieldTypeId`, `FieldShape`, `FieldPart`, `FIELD_TYPE_IDS` |
| Schema | `ItemTypeDefinition`, `ItemTypeSpec`, `ItemTypeMetadata`, `FieldDefinition`, `SectionDefinition`, `NativeProjection`, `TrailerMapping`, `HandlerId`, `PLATFORM_PUBLISHER` |
| Validation | `parse_definition`, `validate`, `Trust`, `DefinitionError`, `DefinitionErrors`, `ErrorCode` |
| Registry | `ItemTypeRegistry`, `Registered`, `Source`, `LoadError`, `RESERVED_TYPE_IDS`, `RESERVED_DIRECTORIES`; `ITEM_TYPE_DIR_ENV` = `OPENSESAME_VAULT_ITEM_TYPE_DIR` for host-provisioned types |
| Native projection | `to_entry`, `from_entry`, `encode_value`, `decode_value`, `FieldValue`, `FieldValues`, `Readback` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-vault-item-types
```

A new built-in type is a JSON file in `marketplace/item-types/builtin/` plus an
`include_str!` entry in `BUILTIN_DEFINITIONS` in [`src/lib.rs`](src/lib.rs);
the TypeScript package regenerates its copy with
`pnpm --filter @opensesame/vault-item-types generate`. Run both planes' tests
after changing the parser.

## Related

- [ADR 0087](../../docs/adr/0087-vault-item-type-plugins.md) — vault item type plugins
- [ADR 0134](../../docs/adr/0134-item-type-marketplaces-and-settings-files.md) — item-type marketplaces
- [`docs/design/vault-item-types.md`](../../docs/design/vault-item-types.md)
