# Add a connection: fal.ai, Higgsfield, Obsidian and Polar as catalog rows

This branch is temporary before/after review material for the catalog-rows pull request (`claude/ecstatic-mayer-wbm2c3-catalog-rows`). It holds no approved evidence, it is not meant to be merged, and it holds nothing but this gallery.

The same journey ran on two real Pages builds, at phone and desktop width:

- **Before:** `main` at `cad62b9b0`. Built from `d4ac20b0e`, whose tree is identical (`git diff d4ac20b0e cad62b9b0` is empty).
- **After:** the branch at `4afef6b81`. Built from `ca9d8644d`, whose tree is identical (`git diff ca9d8644d 4afef6b81` is empty).

The journey (`journey.json`): enter as a guest, switch on External connectors, open Add a connection at `#catalog-<id>`, read the tile's text, measure its box, take the screenshot. All text and sizes below were read from the browser (`report` and `measure` steps of `apps/pages/scripts/capture-evidence.mjs`).

| Sheet | Before | After |
| --- | --- | --- |
| [1280-fal-ai.png](1280-fal-ai.png) | `FAL.ai` · tags `API key` · no kind line · tile 313×83 | `fal.ai` · kind `API key · Provider REST` · tags `API key` · tile 313×83 |
| [1280-higgsfield.png](1280-higgsfield.png) | `Higgsfield` · tags `API key` · no kind line · tile 313×83 | `Higgsfield` · kind `API key · Provider REST` · tags `API key` · tile 313×83 |
| [390-fal-ai.png](390-fal-ai.png) | `FAL.ai` · no kind line · tile 358×64 | `fal.ai` · kind `API key · Provider REST` · tile 358×83 |
| [390-higgsfield.png](390-higgsfield.png) | `Higgsfield` · no kind line · tile 358×64 | `Higgsfield` · kind `API key · Provider REST` · tile 358×83 |

- The tile's name is now the catalog's (`fal.ai`, the same name Settings › Integrations uses).
- fal.ai and Higgsfield now state the protocol their `model_api` row declares (`rest_json`, shown as "Provider REST"), like every other model-provider row.
- On a phone each tile gains that line and grows from 64 to 83 px. At 1280 the grid's rows are already 83 px tall.
- Each tile's action key is the same in both builds.
- Obsidian and Polar read the same in both builds (`Obsidian API key`, `Polar API key`): only the source of their name and category moved to the catalog.

## Build and limits

- Both builds: `VITE_BASE=/OpenSesame/`, `OPENSESAME_BUILD_MODE=hardened`, and a capability profile that is `rich-explicit` minus `networking.tailnet` and the three capabilities that depend on it (`networking.tailnet-devices`, `agents.surrogate-credentials`, `vault.browser-autofill`). This sandbox's network policy refuses `codeload.github.com` (HTTP 403), so the pinned Tailscale source those native assets are built from cannot be fetched here. The catalog rows do not depend on tailnet, and Connections (`connectors.external`) is in both builds.
- Browser gates on the after build: `verify:static` passed every check (766 PASS, no console or page errors). `verify:mobile` passed: the touch contract holds at 320, 390, 430, 844, 1024 and 1366 px.
- `verify:keyboard` was not run, because no control changed: the tile gains a line of text and keeps its key.

Captured 2026-10-31 by Claude Code (agent-assisted) with `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`. Approval: none. These are review captures, not current-state evidence.
