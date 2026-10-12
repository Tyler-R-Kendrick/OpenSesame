# 2026-10 checklist — Playwright walk

`apps/pages/scripts/verification-checklist-walk.mjs` builds Pages and walks the checklist UI. It follows `build-profile.mjs`: `security-profile.mjs`, then `vite build` with `VITE_BASE=/OpenSesame/`. The capability-graph gate is not repeated; this run is UI evidence.

Profiles:

| Profile | Build | Setup choice |
| --- | --- | --- |
| `minimal-local` | `capability-profiles/minimal-local.json` | Minimal |
| `default` | Stock build. There is no `capability-profiles/default.json`. | Default |
| `custom` | Stock build. There is no `capability-profiles/custom.json`. | Custom |
| `full` | `capability-profiles/full.json` (buildKey `full`) | Full |

Screenshots are written to `/opt/cursor/artifacts/verification-2026-10/<profile>/<step>.png`. `results.json` in that directory is the pass/fail note for each check. Key steps: `front-door`, `setup-choices`, `settings-capabilities`, `help-support`, `statusline`, `share-menu`. Capability rows use their own files: `u5-formats-absent`, `u6-age-keys-absent`, `u7-transport-absent`, `u8-travel`, `u9-sealed-store-absent`, `u14-trash-restore`, `u14-trash-delete`, `u14-trash-empty`, `r1-reset-zero`, `r1-reset-one`, `r1-reset-many`, `r2-reset-email`, `r3-password-reset`, `e1-environments`, `e2-environment-toggle`, `e2-required`, `e2-missing-required`. Absence of those capabilities on `minimal-local` is `r1-reset-absent`, `r2-reset-email-absent`, `r3-settings-absent`, and `e1-environments-absent`. A guest who skips the front door, without applying the setup choice, is `share-menu-guest` when that submenu opens.

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

## Tutorials without support models

`apps/pages/scripts/verify-tutorials-profiles.mjs` builds `capability-profiles/minimal-local.json` and `capability-profiles/full.json` the same way (`security-profile.mjs`, then `vite build` with `VITE_BASE=/OpenSesame/`), then walks tutorials in each dist. Minimal leaves the profile's approvals as they are: only installed capabilities. Full turns every other section on. Both runs finish with the on-device model and the remote support model unapproved (`TUTORIALS_AI=off`).

The default command is shard 1/3 at desktop (1280) and phone (390), including the gate pass on shard 1. The full library is the same script with `TUTORIALS_PROFILES_FULL=1`.

```bash
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:tutorials-profiles
```

```bash
TUTORIALS_PROFILES_FULL=1 \
  PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:tutorials-profiles
```

`VERIFY_SKIP_BUILD=1` reuses `apps/pages/dist-profiles/tutorials-<name>/` when `index.html` is already there.
