# 2026-10 checklist — Playwright walk

`apps/pages/scripts/verification-checklist-walk.mjs` builds Pages and walks the checklist UI. It follows `build-profile.mjs`: `security-profile.mjs`, then `vite build` with `VITE_BASE=/OpenSesame/`. The capability-graph gate is not repeated; this run is UI evidence.

Profiles:

| Profile | Build | Setup choice |
| --- | --- | --- |
| `minimal-local` | `capability-profiles/minimal-local.json` | Minimal |
| `default` | Stock build. There is no `capability-profiles/default.json`. | Default |
| `custom` | Stock build, unless `capability-profiles/custom.json` is added. | Custom |
| `full` | Stock build, unless `capability-profiles/full.json` is added. | Full |

Screenshots are written to `/opt/cursor/artifacts/verification-2026-10/<profile>/<step>.png`. `results.json` in that directory is the pass/fail note for each check. Key steps: `front-door`, `setup-choices`, `settings-capabilities`, `help-support`, `statusline`, `share-menu`. A guest who skips the front door, without applying the setup choice, is `share-menu-guest` when that submenu opens.

```bash
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/verification-checklist-walk.mjs
```

Chromium is resolved by `apps/pages/scripts/duress/find-chromium.mjs`: `PLAYWRIGHT_CHROMIUM` when that file exists, then the usual fixed paths, then the Playwright cache. One profile:

```bash
VERIFY_SKIP_BUILD=1 \
  node apps/pages/scripts/verification-checklist-walk.mjs --only default
```

`VERIFY_SKIP_BUILD=1` reuses `apps/pages/dist-profiles/verification-<buildKey>/` when `index.html` is already there. Builds are gitignored under `dist-profiles/`.
