# OpenSesame item-type marketplace

This repository is also a marketplace of vault item types
([ADR 0134](../docs/adr/0134-item-type-marketplaces-and-settings-files.md)),
and it is the one every OpenSesame device lists by default.
`.opensesame/marketplace.json` is the index. The definitions it names live
here, in `item-types/`.

These types are not built in. A person installs one from Settings › Vaults ›
Item types › Marketplace, and it syncs with their vault like any installed
type (ADR 0087 §7).

## Publishing a type

1. Add a `VaultItemType` definition to `item-types/`. It uses the same format
   as `packages/vault-item-types/definitions/` and meets the same rules: no
   handler, no built-in id, no extension another type already uses.
2. List its path in `.opensesame/marketplace.json`.
3. Run `node scripts/pin-marketplace.mjs` to write its SHA-256 pin.
4. Run `pnpm --filter @opensesame/app-core exec vitest run
   src/lib/item-type-marketplace/default-marketplace.test.ts`. It checks
   every pin, that every definition parses as a community type, and that
   nothing collides with a built-in.

## Publishing your own marketplace

Any public git repository can be a marketplace. It needs a
`.opensesame/marketplace.json` in the same shape, whose paths point inside
that repository. List it in Settings by any of these forms:

- `owner/repo`
- a GitHub, GitLab, Codeberg or Bitbucket address, optionally with a
  `/tree/<ref>/<dir>` path
- `gitea+https://host/owner/repo` or `gitlab+https://host/group/repo` for a
  self-hosted forge
- the raw https address of the index itself

Add `#ref` to pin a branch, tag or commit.
