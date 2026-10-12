# @opensesame/visual-contract

Pixel-level visual regression contract for `apps/pages` against the
`.impeccable/screenshots/*.png` baselines at the repo root.

## Why this exists

[`DESIGN.md`](../../DESIGN.md) is the design contract for `apps/pages`: one
light paper surface with a hairline-divided rail, zero-spread neutrals, teal
as the single accent for state and identity (primary actions are ink), the
mono terminal voice with sans prose, the slot-reel `open-sesame` wordmark,
and the front door as the first screen of an empty device (ADR 0115). Those
are qualities a type checker and a unit test suite cannot see. This package
renders the real app with Playwright and diffs it, pixel by pixel, against
six checked-in reference screenshots so a change that silently moves one of
those screens fails a test instead of shipping.

The six baselines it enforces:

| Baseline | What it captures |
| --- | --- |
| `pages-desktop.png` / `pages-mobile.png` | The front door of a fresh device: Set up your own, Join a session, and the guest road as the corner Skip (ADR 0150) |
| `vault-unlock-desktop.png` / `vault-unlock-mobile.png` | The local-only device-PIN seal form behind "Use without an account" — Set up your own, Skip all, then sign-in (Device PIN, Confirm PIN, the no-recovery checkbox) |
| `vault-list-desktop.png` / `vault-list-mobile.png` | The empty vault, right after sealing |

## Running it locally

Run it explicitly — pixel baselines are deliberately *not* part of `pnpm test`
or of `.github/workflows/ci.yml`. Screenshots depend on the host's fonts and
renderer, so a hosted CI runner would fail them for reasons that have nothing
to do with the diff under review. `pnpm test` in this package runs the unit
suite (`src/*.test.ts`) only. The package's `test:integration` script is the
same `playwright test` as `test:visual`, so the root `pnpm test:integration`
(and therefore `pnpm test:all` and `pnpm verify`) does run the pixel contract.

```bash
# from the repo root, after `pnpm install`
pnpm test:visual
# equivalent to:
pnpm --filter @opensesame/visual-contract test:visual
```

This drives `playwright test` (config: `playwright.config.ts`), which:

1. Builds Pages' workspace dependencies with `turbo run build
   --filter=@opensesame/pages^...`, then builds Pages at `VITE_BASE=/` into
   ignored `work/visual-contract-dist`. The existing stamped-build and worker
   output seams preserve the deployment profile and include the distributed
   worker variants. The canonical `apps/pages/dist` remains unchanged.
   Vite previews this isolated output on strict loopback port `5182`;
   `reuseExistingServer: false` prevents reuse of an unrelated developer
   server. Root-base navigation matches Playwright's leading-`/` URLs.
   `PAGES_VISUAL_PREBUILT=1` skips the build and previews an existing
   `work/visual-contract-dist` instead; the config throws unless that
   directory's `index.html` loads `/assets/` (a `VITE_BASE=/` build).
2. Runs `tests/vault-visual-contract.spec.ts` under two projects —
   `desktop` (1440×900, matching the checked-in baselines) and `mobile`
   (390×844, `devices["iPhone 13"]` with
   `isMobile`/`hasTouch`) — walking the first run a visitor walks today:
   the front door (`apps/pages/src/screens/FrontDoor.tsx`, `.door`), the
   "Use without an account" road to the seal form
   (`apps/pages/src/screens/UnlockScreen.tsx`: Device PIN, Confirm PIN,
   the `"Seal with PIN"` button), and the vault
   (`apps/pages/src/sections/VaultSection.tsx`, `.vault`). Desktop shows
   the empty `"Nothing here"` list; phone opens its Sections tree with Vault
   expanded and all selected, retaining the empty list behind it. Both verify
   the unlocked vault and its empty state before capture. Every test gets a fresh browser context, so every run
   is a true first run. The IP-address preview origin cannot host a WebAuthn
   relying party, so enrollment offers PIN; the spec asserts it is selected and
   master-password enrollment is absent (ADR 0180). The vault journey fills a
   valid PIN and actually seals the device. Nothing is mocked: Pages calls no backend by default
   (ADR 0090), so a request that leaves the preview origin, or an uncaught
   page error, fails the test. Service workers are blocked
   (`serviceWorkers: "block"`, as in the other Pages harnesses): a fresh
   context would otherwise install one and reload on its first
   `controllerchange`, at a moment of its own choosing.
3. Screenshots each screen with `page.screenshot()` (not Playwright's own
   `toHaveScreenshot` snapshot mechanism — we need exact, stable output
   filenames to diff against the pre-existing `.impeccable/screenshots/*.png`
   baselines ourselves) and pixel-compares it via `src/compare.ts`
   (`pixelmatch` + `pngjs`, `threshold: 0.1`). A screen fails past a **1.5%**
   mismatch budget measured against all pixels, or past a **5%** budget
   measured against its content pixels (those that are not the baseline's
   dominant background colour in either image), whichever trips first.
4. Always writes `output/<name>-captured.png`; on failure also writes
   `output/<name>-diff.png` (the pixelmatch visual diff) and
   `output/<name>-actual.png` (the raw capture) for a human to look at.
   `output/` is git-ignored — see `.gitignore` — and is never committed.

Browser selection prefers an explicit `PLAYWRIGHT_CHROMIUM` executable,
then `/opt/pw-browsers/chromium`, then the newest installed Chromium in
`PLAYWRIGHT_BROWSERS_PATH` or the standard user cache. Both `chrome-linux`
and `chrome-linux64` cache layouts are supported. A missing explicit path
fails clearly. The selected executable is launched directly; no browser
install or download is needed.

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

- **A mostly-empty screen is cheap to match.** The first budget is a share of
  all pixels, and these screens are mostly paper: a capture of a blank frame
  once passed `pages-mobile` inside 1.5%. `src/compare.ts` therefore also
  measures the diff against the content pixels alone (the 5% budget above),
  and each capture asserts its landmark (the door's card, Device PIN, `.vault`)
  is visible immediately before and after the screenshot. Keep that when
  adding a screen.
- **Motion is frozen for capture.** An init script sets `animation: none` and
  `transition: none`, so the `.unlock__card` settle and the wordmark's slot
  reel stand on their final frame (the reel's letters are its static state,
  `apps/pages/src/components/wordmark.css`). Every capture waits for
  `document.fonts.ready`. Pages uses the system font stacks plus the
  self-hosted Share Tech Mono of the wordmark, so there is no webfont
  network dependency. Two consecutive runs reproduce five of the six
  captures byte for byte; `pages-mobile` varies by about 200 pixels of
  antialiasing in the wordmark (0.06%, far inside the budget).
- **Resolved: desktop viewport now matches the checked-in baselines.** This
  package was originally speced with a 1280×800 desktop viewport, but the
  six PNGs in `.impeccable/screenshots/` were measured (via their PNG
  `IHDR` chunk) at **1440×900** for all three desktop shots
  (`pages-desktop.png`, `vault-unlock-desktop.png`,
  `vault-list-desktop.png`) — the baselines are the design contract, so
  `playwright.config.ts`'s `desktop` project viewport was corrected to
  1440×900 to match rather than rebaselining. The three mobile baselines
  are 390×844, which already matched this suite's mobile viewport.
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
"NEXT DECISION" surface, not a rendering of the then-current teal unlock
screen at all; the `vault-unlock-*`
and `vault-list-*` baselines were stale by smaller, genuine content/copy
changes (e.g. the unlock screen's security-transparency copy grew a
"PIN ≥ 6 chars, salted PBKDF2" clause after those baselines were captured).
None of the differences traced back to this build-out's own changes
(telemetry wiring, a11y fixes) — every diff was inspected visually before
rebaselining, per the rule above that a baseline update must be
intentional and reviewed, not blind.

**2026-09-27.** All six were re-seeded from `main` at `3a832827` plus the fix
below, after each failure was read. They predated, by a month of deliberate
product changes: the front door as the first screen (ADR 0115, `20d3c0fb`),
the slot-reel wordmark (DESIGN.md § Mark, `b8d2048e`), the release notes
beside the gate and the pad moved onto the card (`ed1d403d`), "Reset this
browser?" on the lock screens (`3a832827`), the phone chrome without a tab
bar or statusline (`4358f7fe`), the command bar (`e48fb139`), the Activity
section (`424bc48c`), hidden `trash/` (`34e46bc9`), and `-` for an empty
count (`b13e1f6a`). One difference was a regression, not a design change:
`ed1d403d` left the phone block's own gutter in place, so the seal and unlock
forms sat 20px further in on each side than the front door (at 320px the
theme key covered the wordmark's last letter). That was fixed in
`apps/pages/src/screens/unlock.css` before re-seeding; evidence in
`docs/evidence/2026-09-27-unlock-phone-gutter/`. The spec had also drifted:
`pages-*` could capture the blank frame of a service-worker reload, and it
mocked Host and Identity APIs Pages no longer calls.

**2026-09-28.** Three re-seeded after reading each diff (ADR 0150):
`pages-desktop.png`/`pages-mobile.png` because the front door is now two
roads — Set up your own, Join a session — with guest as the corner Skip and
no sign-in panel; `vault-unlock-desktop.png` only because the release notes
beside the seal form changed two lines of copy. The seal form itself did not
move. The other three still match. Re-seeded the same day for one more
release-notes line (live sessions pair browsers directly, with no server);
nothing else moved. Re-seeded again the same day: the release notes now list
live sessions under Works (directly, or through a tunnel address, TURN server
or code carrier the owner names) rather than under In progress.

**2026-10-05.** Four baselines were deliberately regenerated and reviewed against
latest main after the customer-envelope integration: `pages-desktop.png`,
`pages-mobile.png`, `vault-unlock-mobile.png`, and `vault-list-mobile.png`.
The existing September 28 images predated the reset removal on the front door
(`2716fa064`, #618), the help key on gate screens (`bf096cb53`, #709), and the
phone pane, touch copy, and floating Add button changes (`f2c35f05f`, #632;
`4ba0d48d9`, #660; `db3e7a784`, #698). Those UI changes were already on main;
this encryption change does not introduce them. The desktop seal and list
baselines already passed and were retained. Every changed PNG was opened and
checked against the production UI before a fresh normal comparison run passed
all six screens (27.5 seconds, `VISUAL_UPDATE` unset).
Pixel and content thresholds, font handling, dimensions, and screenshot
comparison logic were not changed. The harness now binds its preview to the
same IPv4 address it probes, and opens the phone's All items list from its
section tree before capturing that list.

**2026-10-08.** A fresh, separate production build of main at `3b2729f73`
reproduced five pixel failures with the corrected enrollment journey. Each
baseline and actual capture was opened and reviewed before copying only those
five captures: front door and seal form at desktop/phone, plus the phone vault
list. Main had already removed master-password enrollment (`8b6499cb4`, #763),
changed gate alignment and collapsed stacked release notes (`9c0eca722`, #769),
kept wide release notes open (`2fe44676b`, #778), and added the seal screen's
Join entry (`6ddaad5a1`, #798). The phone vault header and square controls also
matched that untouched base build. The desktop vault-list baseline passed and
was retained. The spec now follows the real PIN seal instead of waiting for
removed master-password fields. A normal comparison against the connector
branch then passed all six screens with Chrome for Testing 153.0.8010.12,
`VISUAL_UPDATE` unset. Pixel/content thresholds, dimensions, fonts and
comparison code remain unchanged.

## What the orchestrator should do next

If `apps/pages` changes in a way that's expected to alter its rendering,
run `pnpm --filter @opensesame/visual-contract test:visual`, inspect any
failure's `output/*-actual.png` / `*-diff.png` against the current
`.impeccable/screenshots/*.png`, and only rebaseline
(`VISUAL_UPDATE=1 pnpm test:visual`) the specific screens that legitimately
moved — reviewing the six PNGs in the resulting diff before committing,
exactly as this package's own integration pass did.
