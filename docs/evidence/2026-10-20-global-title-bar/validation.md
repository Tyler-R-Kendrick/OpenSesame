# Validation

- Final default production build and worker variants: pass. Native networking
  assets retained their pinned source/compiler, checksum and four-phase build
  verification. The base build also passed.
- Pages TypeScript, changed-file Biome, production-component anti-slop lint,
  design lint: pass.
- `verify:header-layout`: 76 real-browser measurements pass across 15
  viewport/pointer variants, light/dark, long labels, live resize,
  install availability and the actual browser offline event at 320px.
  [Result](header-result.json), [measured geometry](header-layout.json).
- Focused component suites: 107 pass, two pre-existing account context-menu
  expectations fail. The same two expectations fail against the unchanged
  base; neither was weakened.
- Core keyboard journeys: desktop 1280 and mobile 390 pass, including saved
  vault reload/unlock and immediate navigation, guest entry, sections, forms,
  Escape and locking. The full required keyboard gate stops in its live
  session helper waiting for a missing `Live sessions` settings link; the
  unchanged base reproduces the identical timeout. The supplemental mobile
  core walk stops before that separately failing helper and is not reported
  as a full gate pass.
- Full mobile matrix (320, 390, 430, landscape, both tablet orientations):
  1,104 assertions pass and 152 screen stops pass. Four failures are the
  missing phone Keybindings tab, reproduced on the unchanged base at all four
  phone sizes. All layout, touch floors, menus, settings-file, protector-unlock
  and tablet checks pass.
- Structural quality gate: the same 23 existing failures on base and branch;
  no new structural failures or relaxed baseline.
- CI gate mapping tests: 28 pass, one pre-existing trusted-contacts shard
  coverage failure (`verify:trusted-contacts runs in 0 steps`).

The header test initially exposed an actual offline-state regression:
negative margins on the tappable status glyph overlapped Install by 12px at
320px. The final header reserves the whole 44px target; status ends at
185.59px and Install begins at 185.59px. The brand ends at 137.11px, before
the tools begin at 141.59px. This state now passes the committed browser test.
