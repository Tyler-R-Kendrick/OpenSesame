# tests/fixtures

Committed inputs that more than one suite, or more than one plane, is checked
against. A fixture belongs here when a Rust crate and a TypeScript package must
agree on the same bytes; a fixture only one package reads stays beside that
package (for example `crates/provider-bitwarden/tests/fixtures/`).

## Where it fits

- Nothing here is a real credential. The env-spec schema holds ConnectionRef
  handles, not values; the KDBX passwords are literal `fixture-*` strings and
  the TOTP seed is the RFC 6238 test vector.
- `kdbx/roundtrip.expected.json` is excluded from Biome
  ([`biome.json`](../../biome.json)); the Rust conformance test writes it.

## Files

| Path | What it is | Read by |
|---|---|---|
| [`kdbx/roundtrip.kdbx`](kdbx) | A KDBX 4.1 database (password `correct horse battery staple`, reduced Argon2id cost) that exercises every mapped field type | `crates/kdbx-bridge/tests/conformance.rs` (`opensesame-kdbx-bridge`); `packages/app-core/src/lib/vault/import/formats/kdbx.test.ts` and `kdbx.characterization.test.ts` |
| [`kdbx/roundtrip.expected.json`](kdbx) | The sealed-store item set that database maps to — the one mapping ADR 0052 §4.5 freezes for both planes | the same Rust conformance test and `kdbx.test.ts` |
| [`kdbx/README.md`](kdbx/README.md) | The fixture's parameters, what it covers, and why it is 4.1 | — |
| `demo.env.schema` | A small `@env-spec` schema: one `@public` URL and two `@sensitive` values written as `opensesame(conn://…)` / `opensesameConnection(conn://…, projection=legacy-token)` handles | `crates/env-spec/src/lib.rs` test `bridge_roundtrip_fixture` (`opensesame-env-spec`); `scripts/test/env-spec-dev-smoke.sh`; the `opensesame dev` examples in [`docs/operators/local.md`](../../docs/operators/local.md) and [`skills/opensesame-clis`](../../skills/opensesame-clis/SKILL.md) |

## Develop

```bash
cargo +1.88.0 test -p opensesame-kdbx-bridge --test conformance
cargo +1.88.0 test -p opensesame-env-spec bridge_roundtrip_fixture   # skips itself when node is absent
pnpm --filter @opensesame/app-core exec vitest run src/lib/vault/import/formats/kdbx
cargo run -p opensesame-cli -- dev check --schema tests/fixtures/demo.env.schema
```

The KDBX pair is regenerated, never hand-edited, and the new bytes differ on
every run (fresh seeds, IVs and UUIDs):

```bash
cargo +1.88.0 test -p opensesame-kdbx-bridge --test conformance -- --ignored regenerate_fixture
```

Then run the TypeScript suites above: the app-core adapter must read the new
file and agree with the new JSON. Tests reach these files by relative path from
the repository root, so moving one means updating each reader in the table.

## Related

- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) — password-manager bridging and the frozen KDBX mapping
- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec delivery modes
- [`crates/kdbx-bridge/README.md`](../../crates/kdbx-bridge/README.md) — the Rust side of the conformance pair
