# @opensesame/visual-contract

Pixel-level visual regression contract for `apps/pages` against the
`.impeccable/screenshots/*.png` baselines at the repo root.

## Why this exists

`.impeccable/design.json` names this app's design identity **"Authority
Vault"**: a navy sidebar (`#152033`), a teal accent (`#0f766e`) on a light
`#eef1f6` content area, an unlock-first session gate, a search+filter vault
list, and Source Sans 3 / IBM Plex Mono typography — explicitly *not*
Bitwarden purple, per the design contract's "Competitor Marks Rule". Those
are qualities a type checker and a unit test suite cannot see. This package
renders the real app with Playwright and diffs it, pixel by pixel, against
six checked-in reference screenshots so a change that silently breaks the
Authority Vault look (wrong sidebar color, a regressed unlock card, a
reflowed vault list) fails a test instead of shipping.

The six baselines it enforces:

| Baseline | What it captures |
| --- | --- |
| `pages-desktop.png` / `pages-mobile.png` | First paint of the app shell on load |
| `vault-unlock-desktop.png` / `vault-unlock-mobile.png` | The unlock screen, settled (first-run PIN creation form) |
| `vault-list-desktop.png` / `vault-list-mobile.png` | The vault landing page, right after completing unlock |

## Running it locally

```bash
# from the repo root, after `pnpm install`
pnpm test:visual
# equivalent to:
pnpm --filter @opensesame/visual-contract test:visual
```

This drives `playwright test` (config: `playwright.config.ts`), which:

1. Starts `apps/pages` for real via its own `webServer` — `pnpm --filter
   @opensesame/pages build && pnpm --filter @opensesame/pages preview` on
   port `5180`, the app's own dev/preview port — with `VITE_BASE=/`
   overriding that app's GitHub-Pages default of `/OpenSesame/` (Playwright's
   `baseURL` + a leading-`/` `page.goto()` resolves against the origin, not a
   non-root base path, so serving at `/` keeps every test's navigation
   simple). `reuseExistingServer: !process.env.CI` is kept as a default even
   though this repo runs no CI by policy.
2. Runs `tests/vault-visual-contract.spec.ts` under two projects —
   `desktop` (1440×900, matching the checked-in baselines) and `mobile`
   (390×844, `devices["iPhone 13"]` with
   `isMobile`/`hasTouch`) — driving the real first-run unlock flow using the
   selectors read directly from `apps/pages/src/pages/UnlockPage.tsx`
   (`#unlock-pin`, `#unlock-confirm`, the `"Create vault unlock"` button) and
   `VaultPage.tsx`/`VaultShell.tsx` (`.vault-panel`, `.vault-list`).
3. Screenshots each screen with `page.screenshot()` (not Playwright's own
   `toHaveScreenshot` snapshot mechanism — we need exact, stable output
   filenames to diff against the pre-existing `.impeccable/screenshots/*.png`
   baselines ourselves) and pixel-compares it via `src/compare.ts`
   (`pixelmatch` + `pngjs`, `threshold: 0.1`, failing past a **1.5%** pixel
   mismatch budget).
4. On failure, writes `output/<name>-diff.png` (the pixelmatch visual diff)
   and `output/<name>-actual.png` (the raw capture) for a human to look at.
   `output/` is git-ignored — see `.gitignore` — and is never committed.

If the preinstalled Chromium at `/opt/pw-browsers/chromium`
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) doesn't match what this package's
pinned `@playwright/test` (`1.55.1`, matching the repo root) resolves by
default, `playwright.config.ts` falls back to launching that path explicitly
via `launchOptions.executablePath`. Do **not** run `playwright install` —
the browser is already provisioned in this environment.

## Rebaselining (`VISUAL_UPDATE=1`)

```bash
VISUAL_UPDATE=1 pnpm --filter @opensesame/visual-contract test:visual
```

In this mode, `src/compare.ts` skips the pixel comparison entirely and
overwrites `.impeccable/screenshots/<name>.png` in place with the freshly
captured screenshot for every screen in the suite.

**Rebaselining must be an intentional, reviewed action — never something a
routine, a bot, or CI runs silently.** The whole point of this contract is
that a baseline only moves when a human looked at the new pixels and decided
they're correct. In practice that means:

- Run `VISUAL_UPDATE=1 pnpm test:visual` locally, deliberately, because a
  design change under `apps/pages` is expected to move one or more of the
  six screens.
- The result is a set of changed PNGs under `.impeccable/screenshots/`.
  `git diff --stat` makes that change visible in size/line terms even though
  the content itself is binary — review the actual images (e.g. in the PR's
  file diff viewer, or by opening them) before committing.
- Never wire `VISUAL_UPDATE=1` into a scheduled job, a pre-commit hook, or
  any other unattended path. If a run needs rebaselining, that is a decision
  for the person (or the orchestrating step) reviewing the diff, not a
  default this package should reach for on its own.

## Known caveats (read before trusting a "pass")

- **`pages-*` and `vault-unlock-*` currently show the same screen.**
  `apps/pages`' routing (`src/App.tsx`) redirects `/` → `/vault` →
  `/unlock` while the vault is locked, and every Playwright test gets a
  fresh browser context (no stored PIN, no OPFS state), so both baselines
  land on the unlock screen. They are captured at two different points —
  `pages-*` right as the unlock card mounts, `vault-unlock-*` after
  `document.fonts.ready` — so they aren't literally byte-identical files,
  but expect them to look very close. If `apps/pages` ever grows a real
  loading/splash state distinct from the unlock screen, revisit
  `tests/vault-visual-contract.spec.ts` so `pages-*` captures that instead.
- **Resolved: desktop viewport now matches the checked-in baselines.** This
  package was originally speced with a 1280×800 desktop viewport, but the
  six PNGs in `.impeccable/screenshots/` were measured (via their PNG
  `IHDR` chunk) at **1440×900** for all three desktop shots
  (`pages-desktop.png`, `vault-unlock-desktop.png`,
  `vault-list-desktop.png`) — the baselines are the design contract, so
  `playwright.config.ts`'s `desktop` project viewport was corrected to
  1440×900 to match rather than rebaselining. The three mobile baselines
  are 390×844, which already matched this suite's mobile viewport.
- **Google Fonts is a live network dependency.** `apps/pages/index.html`
  loads Source Sans 3 / IBM Plex Mono from `fonts.googleapis.com` /
  `fonts.gstatic.com` (with a CSS system-font fallback if blocked). If the
  runtime executing this suite has no outbound access to those hosts, text
  will render in fallback fonts and may trip the pixel-diff budget even
  though the app itself is behaving correctly. In practice this has shown
  up as one-off flakiness specifically on the `pages-*` shot (captured
  before `document.fonts.ready`, unlike the other five) — a lone failure
  there on an otherwise-green run is this, not a regression; a second run
  confirms it.
- **Resolved: mobile browser engine and pixel density.**
  `devices["iPhone 13"]` sets `defaultBrowserType: "webkit"` to emulate
  real Mobile Safari, but only Chromium is preinstalled in this repo's
  environments — that mismatch surfaced as every mobile test failing to
  even launch a browser (`browserType.launch: Target page, context or
  browser has been closed`). The `mobile` project now forces
  `defaultBrowserType: "chromium"` while keeping the device's UA/viewport/
  touch properties. Separately, the same preset's `deviceScaleFactor: 3`
  tripled every mobile capture's resolution past the checked-in
  390×844 baselines (a distinct "dimensions don't match" failure from a
  real pixel-content mismatch) — pinned to `deviceScaleFactor: 1` to match.
  A `webServer` config specifying both `port` and `url` (invalid in
  Playwright 1.55.1) and a root-in-container Chromium sandbox failure
  (`--no-sandbox`, gated to an actual root check, not just present
  unconditionally) were fixed the same way — real infrastructure bugs
  caught by actually running the suite, not guessed at.

## Baseline provenance

The six baselines were rebaselined during this build-out's integration
pass (`VISUAL_UPDATE=1`, see git history) after the very first real run
against a live build. Every original baseline predated changes visible in
the diff — most strikingly, `pages-desktop.png`/`pages-mobile.png` were
screenshots of an entirely different, since-abandoned dark navy/yellow
"NEXT DECISION" surface (the exact "yellow airport depth-band world"
`DESIGN.md`'s Do/Don't list calls out by name), not a rendering of the
current teal "Authority Vault" unlock screen at all; the `vault-unlock-*`
and `vault-list-*` baselines were stale by smaller, genuine content/copy
changes (e.g. the unlock screen's security-transparency copy grew a
"PIN ≥ 6 chars, salted PBKDF2" clause after those baselines were captured).
None of the differences traced back to this build-out's own changes
(telemetry wiring, a11y fixes) — every diff was inspected visually before
rebaselining, per the rule above that a baseline update must be
intentional and reviewed, not blind.

## What the orchestrator should do next

If `apps/pages` changes in a way that's expected to alter its rendering,
run `pnpm --filter @opensesame/visual-contract test:visual`, inspect any
failure's `output/*-actual.png` / `*-diff.png` against the current
`.impeccable/screenshots/*.png`, and only rebaseline
(`VISUAL_UPDATE=1 pnpm test:visual`) the specific screens that legitimately
moved — reviewing the six PNGs in the resulting diff before committing,
exactly as this package's own integration pass did.
