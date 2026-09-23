# Visual evidence: item-type marketplaces and Settings as files

These are before/after sheets for
[ADR 0134](../../adr/0134-item-type-marketplaces-and-settings-files.md).
The change redesigns the Item types panel and adds git-repository
marketplaces. Settings' source view becomes a file viewer over the files
the panel is drawn from.

Both sides are **real production builds** (`VITE_BASE=/OpenSesame/`).
`apps/pages/scripts/capture-evidence.mjs` walked each one the same way,
using [`journey.json`](journey.json):

| side | source |
| --- | --- |
| before | `9fa21d8` (`main`; `apps/pages/src`, `packages/app-core/src` and `packages/capability-registry/src` checked out from it) |
| after | this branch |

**One disclosed substitution.** The default marketplace is
`github:tyler-r-kendrick/OpenSesame#main`, and its index,
`.opensesame/marketplace.json`, only exists on `main` once this branch
lands. So the journey's `remote` map serves the six files this branch adds
(the index and five definitions) for their
`raw.githubusercontent.com/.../main/...` URLs. It serves them byte for byte
from the working tree, with the CORS header that host sends. Nothing else
is mocked. The pins in the index are checked against those same bytes by
`default-marketplace.test.ts`.

Every caption's before/after line is a measurement taken from the browser,
by a script that walks guest → Settings → Vaults on each build:

| measurement | before | after |
| --- | --- | --- |
| Item types panel right edge, 390px viewport | 462px (clipped) | 374px (inside the 16px gutter) |
| remove keys on built-in types (all no-ops before) | 23 | 0 |
| panel-level toggles / paste boxes | Visual/Source + 1 | 0 + 0 |
| tabs | none | Installed, Marketplace |
| files in Settings › Vaults source view | 1 (`settings/vaults.yaml`) | 25 (+1 per installed type) |
| marketplaces / offers | 0 / 0 | 1 / 5 |

## The sheets

| sheet | what it shows |
| --- | --- |
| [`1280-installed.png`](1280-installed.png) | Item types at 1280. Before: a nested Visual/Source toggle, an always-open paste box and 23 remove keys that do nothing. After: flat tabs. Installed is `installed/*.json`; the built-ins are folded, read-only, under `builtin/`. |
| [`1280-marketplace.png`](1280-marketplace.png) | New Marketplace tab. `marketplaces.json` lists ours by default. Opening the tab reads it, and nothing is read before that. Five offers, each led by its vault extension. |
| [`1280-installed-vehicle.png`](1280-installed-vehicle.png) | Inspect shows the fields, with concealed ones locked, before install acts. Install writes `installed/vehicle.json`. |
| [`1280-file-marketplaces.png`](1280-file-marketplaces.png) | The row's open key switches Settings to its source view, now a file tree beside the open file. |
| [`1280-file-vehicle.png`](1280-file-vehicle.png) | An installed type is a file with save and remove keys. Built-ins open read-only. |
| [`390-installed.png`](390-installed.png) | Phone: before, Settings' column grew past the edge. After, it fits. |
| [`390-marketplace.png`](390-marketplace.png) | Phone: actions wrap under each row. Every key keeps its 44px target. |
| [`390-file-vehicle.png`](390-file-vehicle.png) | Phone: the file tree sits above the open file. |

Gates run on the branch build: `verify:mobile` (320, 390, 430, 844, 1024,
1366px), `verify:keyboard` and `verify:static` pass.
