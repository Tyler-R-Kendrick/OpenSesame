# Operator-controlled capability composition — before / after

Two real builds, walked the same way, at desktop and phone width.

| | |
|---|---|
| **base** | `origin/main` at [`6bd08e3`](https://github.com/Tyler-R-Kendrick/OpenSesame/commit/6bd08e39685516a56b009bf50a4b315e311e2f7b), built in its own worktree with its own build pipeline |
| **branch** | `claude/new-session-9wpwbh` at [`38865cf`](https://github.com/Tyler-R-Kendrick/OpenSesame/commit/38865cf5d4a83bf07ae859e6c3f801569a0af129) |
| **origin** | `https://tyler-r-kendrick.github.io/OpenSesame/`, served from `dist/` exactly as GitHub Pages serves it |
| **browser** | the container's pinned Chromium, headless |

The base could not be captured by reverting `apps/pages/src` in place, the
way `capture-evidence.mjs` documents: this branch changes the build pipeline
itself (`build-workers.mjs` is new here, and refuses main's service worker),
so main's source cannot pass this branch's build. It was built in a separate
worktree at `origin/main` instead, with main's own toolchain, and that
`dist/` was served to the same harness. That is a more faithful base than the
documented procedure, not a weaker one.

## The sheets

| Sheet | What it shows |
|---|---|
| [`1280-setup-first-tab.png`](1280-setup-first-tab.png) | What setup asks a household first. Four tabs opening on a connector directory endpoint → one tab, which asks what kind of installation this is. |
| [`390-setup-first-tab.png`](390-setup-first-tab.png) | The same first screen on a phone: two roads, no fields. |
| [`1280-setup-choice.png`](1280-setup-choice.png) | Choosing a purpose, then each capability: 5 purposes, 31 cards, 11 on for Family. |
| [`1280-settings-capabilities.png`](1280-settings-capabilities.png) | The rail an installation that approved nothing carries (9 rows, against main's 17), and the new Settings tab with its **Add** key. |
| [`390-settings-capabilities.png`](390-settings-capabilities.png) | The same list on a phone: 31 rows, 62px each. |

## The numbers

Every figure quoted in a caption is read out of the running build by
[`measure.mjs`](measure.mjs), not out of the source, and is kept beside the
sheets in [`measurements.before.json`](measurements.before.json) and
[`measurements.after.json`](measurements.after.json).

```bash
# against whichever build is in apps/pages/dist
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node docs/evidence/2026-09-22-capability-composition/measure.mjs after
```

| | base | branch |
|---|---|---|
| setup tabs | connectors, ai, identity, mfa | capabilities |
| roads in | — | minimal, customize |
| purposes | 0 | 5 |
| capability cards | 0 | 31 (11 selected by Family) |
| settings nav | General · Security · Vaults · **Connections** · Danger | General · Security · Vaults · **Capabilities** · Danger |
| rail rows, guest, nothing approved | 17 | 9 |
| capability rows | — | 31, 62px each, desktop and phone alike |

## Reproducing

```bash
J=docs/evidence/2026-09-22-capability-composition/journey.json

git worktree add --detach /tmp/os-base origin/main
(cd /tmp/os-base && pnpm install --frozen-lockfile \
  && VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages)
cp -r /tmp/os-base/apps/pages/dist apps/pages/dist
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"

rm -rf apps/pages/dist
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"

PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

## What capturing this found

The first attempt at the branch capture failed on the first step, and that is
the reason this folder exists rather than a note saying the change was
verified by its tests. The production build did not boot: `cap-agents.webmcp`
evaluated React Router's `createContext` before the chunk holding React had
run, the page threw on load and rendered nothing, and `verify:static` could
not find the wordmark. Three more defects followed from walking the built
page — a consent screen that reported an empty change set, three capabilities
registering their surface into a port nothing implemented, and a capability
that could be chosen once and never again. None of them is visible before
bundling or outside a real page, and 4,382 passing unit tests saw none of
them. They are fixed in `38865cf`.
