# Item-type marketplace

A vault item type — account, passport, Wi-Fi network, gift card — is a JSON
manifest, never code ([ADR 0087](../docs/adr/0087-vault-item-type-plugins.md)).
This directory holds every definition this repository publishes:

| Directory | What it holds | How a vault gets it |
|---|---|---|
| [`item-types/builtin/`](item-types/builtin) | The built-in types (28 files). Both planes embed these files at build time. `crates/vault-item-types` embeds 23 with `include_str!`; the five credential types of [ADR 0179](../docs/adr/0179-credentials-are-entries-bound-to-accounts.md) (`password`, `api-key`, `token`, `oauth-client`, `authenticator`) are in this directory but not embedded there. `packages/vault-item-types` generates modules: the five core types (`secret`, `file`, `passkey`, `certificate`, `drop`) in the bundle and every other file as a pack ([ADR 0165](../docs/adr/0165-item-type-packs-on-demand.md)). | The core types are always present; the other types are packs a person switches on in Settings › Vaults › Item types. |
| [`item-types/optional/`](item-types/optional) | Types published alongside OpenSesame but not built in. [`.opensesame/marketplace.json`](../.opensesame/marketplace.json) indexes them, which makes this repository a marketplace ([ADR 0134](../docs/adr/0134-item-type-marketplaces-and-settings-files.md)) — the one every device lists by default. | A person installs one from Settings › Vaults › Item types › Marketplace; it then syncs with their vault like any installed type. |

Both sets use the same format and pass the same parser. How to write a
definition — field types, concealed fields, subtitles, search — is in
[docs/design/vault-item-types.md](../docs/design/vault-item-types.md).

## Changing a built-in type

1. Edit or add the JSON in `item-types/builtin/`.
2. Regenerate the TypeScript embedding:
   `pnpm --filter @opensesame/vault-item-types generate`.
3. Add the file to `BUILTIN_DEFINITIONS` in `crates/vault-item-types/src/lib.rs`
   if it is new and the host plane should know the type.
4. `pnpm --filter @opensesame/vault-item-types test` and
   `cargo +1.88.0 test -p opensesame-vault-item-types` must both pass — the
   generated module is checked against the JSON.

## Publishing an optional type

1. Add the definition to `item-types/optional/`. It must not name a handler,
   reuse a built-in id, or claim an extension another type already uses.
2. List its path in `.opensesame/marketplace.json`.
3. Pin it: `node scripts/release/pin-marketplace.mjs`.
4. Check it: `pnpm --filter @opensesame/app-core exec vitest run
   src/lib/item-type-marketplace/default-marketplace.test.ts`. That verifies
   every pin, that every definition parses as a community type, and that none
   collides with a built-in.

## Publishing your own marketplace

Any public git repository can be a marketplace. It needs a
`.opensesame/marketplace.json` of the same shape whose paths point inside that
repository. A person adds it in Settings by any of these forms:

- `owner/repo`
- a GitHub, GitLab, Codeberg or Bitbucket address, optionally with a
  `/tree/<ref>/<dir>` path
- `gitea+https://host/owner/repo` or `gitlab+https://host/group/repo` for a
  self-hosted forge
- the raw https address of the index itself — use this for GitHub Enterprise
  or Bitbucket Server, whose raw routes are not the public ones

Add `#ref` to pin a branch, tag or commit. A marketplace confers no trust:
everything it offers goes through the same parser and registry as a built-in.
