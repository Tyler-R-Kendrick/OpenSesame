# Visual evidence — browser-local SOPS

Before/after sheets for the user-visible part of
[browser-local SOPS](../2026-09-22-browser-local-sops/README.md)
([ADR 0130](../../adr/0130-browser-local-sops.md)).

Both sides are **real builds**, walked identically by
`apps/pages/scripts/capture-evidence.mjs` with the journey in
[`journey.json`](journey.json):

| side | source | build |
| --- | --- | --- |
| before | `424bc48` (this branch's parent) | `VITE_BASE=/OpenSesame/`, production |
| after | this branch | `VITE_BASE=/OpenSesame/`, production |

Every caption's before/after line is a **measurement read from the browser**,
not an impression: header-key `aria-label`s enumerated from the live panel,
control bounding boxes from the open dialog, and the file input's computed
style. The measuring script is in the evidence trail below.

## Sheets

| | |
| --- | --- |
| [`1280-formats-panel.png`](1280-formats-panel.png) | Settings › Security › Formats, desktop. 3 header keys → 4. |
| [`1280-sops-sheet.png`](1280-sops-sheet.png) | The SOPS document sheet, desktop. Did not exist → exists. |
| [`390-formats-panel.png`](390-formats-panel.png) | The same panel in a real touch context at 390. |
| [`390-sops-sheet.png`](390-sops-sheet.png) | The sheet on a phone. |

## What the pairs show

**The panel gained one key, and the key is the point.** Before, the Formats
header offered `Export native protection manifest`, `Vault SOPS` and
`age armor` — you could export the *vault* as a SOPS document, but there was
no road to an arbitrary SOPS file, while the SOPS row already showed read,
write and "this browser". After, `SOPS document` is there and the row's
claim is true.

**The "before" sheet shots are the panel again, deliberately.** Pressing a
key that does not exist cannot open anything, so the base walk photographs
what a person actually sees when they look for this feature and it is not
there. That is the honest before, and the caption says so rather than
leaving a reader to guess why the two halves differ in kind.

**One layout defect was found by this capture and fixed in it.** An earlier
run showed Chromium's native "Choose File" button rendering on top of the
`age identity` label, clipped to the two letters "Cl". The native input is
now `opacity: 0; position: absolute` behind the `+` icon key — measured in
the after caption — and the current sheet shows the label unobstructed.

## Reproduce

```bash
J=docs/evidence/2026-09-22-browser-local-sops-visual/journey.json

# the base, built in its own worktree so the branch's added files are absent
git worktree add /tmp/base 424bc48
( cd /tmp/base && VITE_BASE=/OpenSesame/ \
    pnpm exec turbo run build --filter=@opensesame/pages )
cp -r /tmp/base/apps/pages/dist apps/pages/dist
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"

# the branch
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"

PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

A worktree is needed rather than `git checkout 424bc48 -- apps/pages/src`,
which the skill's usual recipe suggests: that form restores the base's files
but does not delete the ones this branch adds, so the "base" build is a
mixture that does not compile. Only committed sheets live here; the raw
walks go to a temporary directory.

## What this does not show

The engine itself. A screenshot cannot demonstrate that a document decrypts
to the same bytes upstream produces, or that nothing left the origin — those
are `pnpm verify:sops-conformance` and `pnpm verify:sops-browser`, reported
in [`../2026-09-22-browser-local-sops/`](../2026-09-22-browser-local-sops/README.md).
