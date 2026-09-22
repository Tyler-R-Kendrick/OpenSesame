# Visual evidence — the Item types panel

Before/after sheets for the user-visible part of "all experience journeys
pass" ([ADR 0087 §7](../../adr/0087-vault-item-type-plugins.md): install and
uninstall are data writes a user can do at runtime; capability
`vault.item_types.install` → `route:/settings`).

Both sides are **real builds**, walked identically by
`apps/pages/scripts/capture-evidence.mjs` with the journey in
[`journey.json`](journey.json):

| side | source | build |
| --- | --- | --- |
| before | `ee68f79c` (this branch's parent) | `VITE_BASE=/OpenSesame/`, production |
| after | this branch | `VITE_BASE=/OpenSesame/`, production |

Every caption's before/after line is a **measurement read from the browser**,
not an impression: the panels rendered in Settings › Vaults counted from the
live page, the rows of `aria-label="Installed types"` counted from the live
list, and the per-row Remove keys counted by accessible name. The measuring
run reported `panels=2 itemTypeRows=23 removeKeys=23` on the branch build,
matching the 23 built-in manifests in
`packages/vault-item-types/definitions/` that a fresh vault carries.

## The sheets

| sheet | what it claims |
| --- | --- |
| [`1280-item-types.png`](1280-item-types.png) | Settings › Vaults at 1280 × 900. Before: the category ended at the vault switcher — the install/remove capability had no surface at all, though `installItemTypeDefinition` / `uninstallItemTypeDefinition` existed and were tested. After: the Item types panel — paste a manifest, inspect its fields through the same Source/Visual pair the rest of Settings uses, install with no reload, remove without rewriting the item values it shaped. Panels 1 → 2, item-type rows 0 → 23, remove keys 0 → 23. |
| [`390-item-types.png`](390-item-types.png) | The same change at 390 × 844. The panel stacks under the vault list with the same controls in the same order; nothing floats over them. Panels 1 → 2, rows 0 → 23. |

The rest of the change is not a pixels change and is evidenced by the gates
named in the pull request: the eight experience walks (their own captures in
`artifacts/experience-journeys/`), the 3,572 unit tests, and
`pnpm lint` / `pnpm quality:gate` / `pnpm typecheck`.