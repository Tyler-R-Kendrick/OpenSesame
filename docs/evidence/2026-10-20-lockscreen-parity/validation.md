# Validation

Base: `a03b3c5094b7aeef0a18ff0aabe31c023925a43b`. Before and after use
separate production builds with the frozen lockfile and generated service
workers. The capture journey seals a vault with a PIN and locks it through
real controls; it does not inject component state or arrange the screenshot.
The screenshots show the app with normal animation enabled. Browser checks
also exercise both themes, viewport changes, notes expansion, real PIN unlock
and reduced motion. See the gallery and its recorded browser measurements.

## Passed

- Final custom browser parity matrix: nine viewports (1663×946, 1280×900,
  1100×900, 1024×1366, 320×568, 390×844, 430×932, 844×390, 568×320),
  81 measurement records, 603 passing checks and zero failures. Both themes, normal animated
  rings/wordmark, real PIN doors, expanded-note pointer access, no overlapping
  stacked rows, live resizing and visible static reduced motion are checked.

- Final Pages production build, service workers and TypeScript check.
- 18 cipher tests, including geometry, static repaint after resize and retained
  successful-alignment illumination.
- 148 broader UI tests covering unlock methods, keyboard behavior, passkeys,
  recovery, guest access, configured identity, FrontDoor, release notes and
  responsive hero placement.
- Changed-file Biome lint, control design lint, artifact inventory/rebuild and
  its 107 existing tests; no manifest or lockfile changes.
- App-core/vault-core boundaries and restricted seams; log-hygiene gate.
- 861 repository script tests and 14 security tests in the broader quality run.
- Existing mobile gate: both tablet layouts (1024 and 1366px) complete. All
  phone layouts (320, 390, 430 and 844px landscape) pass 33 vault, settings,
  file, unlock and protector stops before the unrelated failure below.
- Existing keyboard gate: 15 desktop assertions pass, including real WebAuthn,
  Access/Identity navigation and keyboard lock/reload, before its unrelated
  failure below.

## Existing failures and environment limits

These failures were reproduced on the unchanged base, with the same driver:

- `verify:keyboard`: the live-session helper waits for a `Live sessions` link
  that is absent from the current settings navigation
  (`scripts/lib/live-keyboard-contract.mjs:133`).
- `verify:mobile`: the trusted-contacts helper waits for the absent
  `Make the invitation` button (`scripts/lib/mobile-trusted-contacts.mjs:77`).
- `quality:gate`: `packages/app-core/src/lib/ai-connections/assemblyai-inference.ts`
  has complexity 1 against a recorded allowance of 0. No baseline was relaxed.

The full quality command is not green: its security test requires `promptfoo`
from the red-team dependency graph, which is not installed in this scoped
workspace. The package-coupling check also requires Cargo, which is absent
from this runtime. These checks were not bypassed or reported as passing.
Full repository tests and native platform runtimes were not run for this
browser layout change. CI remains the merge gate.
