---
name: visual-evidence
description: Capture before/after screenshots for any user-visible change and post them on the pull request, so a reviewer never has to run the app to see what changed. Use whenever a change touches CSS, a component, a screen, layout, chrome, copy shown on screen, an empty state, or anything else a person would look at.
---

# Visual evidence

A pull request that changes what people see has to show it. A reviewer should
not have to clone the branch, install, build and walk the app to find out
whether a change helped — and "I ran it and it looks good" is not evidence, it
is a claim about a screen nobody else saw.

So: **every user-visible change carries before/after images on the PR.**

## When this applies

Any diff that a person could notice on screen. CSS, a component, a screen, a
route, layout, chrome, on-screen copy, an icon, an empty state, an error state,
a focus ring. If you are unsure whether a change is visible, capture it — a
pair of identical images is a cheap, honest answer.

It does **not** apply to changes with no rendered surface: a Rust crate, a
build script, a test harness, a type, a doc. Those carry their own evidence
(the gate output, the failing test that now passes).

## The rule

1. **Two real builds, never one.** The "before" is the base branch's build,
   not memory and not a description. Both captures walk the same screens with
   the same steps, so the only difference in the pair is the change.
2. **Every pair carries a measurement.** "Looks better" is not a finding.
   `statusline 99px, wrapped → 49px, one row` is. Take the number from the
   browser, not from the CSS you wrote.
3. **Phone and desktop both**, for anything in a shared layout or control.
   Most regressions this catches are at one width and invisible at the other.
4. **The images reach the PR**, not only the chat. Commit them under
   `docs/evidence/<yyyy-mm-dd>-<topic>/` with a `README.md` that lays them out,
   and link that gallery from the PR body under `## Visual evidence`, by commit
   SHA so it survives the branch being deleted. See *Posting it* — the body
   itself cannot carry image embeds through the tooling here.
5. **Never stage the screenshot.** Capture the app as it actually runs, from a
   real build, on the paths the journey names. No hand-placed elements, no
   devtools overlays, no cropping that hides the thing you changed.

## How

`apps/pages/scripts/capture-evidence.mjs` does the capture and composes the
sheets. A journey file names the screens, the steps and what each pair claims;
it lives beside the evidence it produced, because a caption that outlives its
change is a caption nobody rechecks.

```bash
BASE=$(git merge-base HEAD origin/main)
J=docs/evidence/2026-09-13-mobile-touch/journey.json

# 1. the base. Only `src` is reverted: the harness lives in `scripts`.
git checkout "$BASE" -- apps/pages/src
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"

# 2. the branch
git checkout HEAD -- apps/pages/src
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"

# 3. the sheets, into the journey file's own directory
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

Check `git status` is clean after step 2 before you continue — step 1 writes to
the index as well as the working tree, and a half-reverted tree would ship the
base's CSS.

Raw captures land in the system temp directory; only the composed sheets are
committed. Keep the set small: six to ten sheets that each show one thing, not
every screen the app has.

### The journey file

```json
{
  "out": ".",
  "screens": [
    {
      "width": 390,
      "height": 844,
      "steps": [
        { "guest": null },
        { "tab": "Settings" },
        { "shot": "390-settings" }
      ]
    }
  ],
  "sheets": [
    {
      "shot": "390-settings",
      "width": 390,
      "title": "Settings controls — 390 × 844",
      "caption": "What changed and why, in the product's own voice.",
      "before": "36px keys, 24px switches",
      "after": "44px throughout"
    }
  ]
}
```

Steps are `guest`, `tab`, `press`, `open`, `escape` and `shot`. Add a verb to
`STEPS` in the script when a journey needs one; keep them named after what a
person does, not after the DOM.

## Posting it

Write a `README.md` in the evidence directory: the sheets in reading order,
each under its own heading, each with its measurement, images by **relative
path**. That file is the gallery a reviewer opens, and GitHub renders it.

Then link it from the PR body under `## Visual evidence`, with the measurements
listed so the summary is readable without clicking:

```markdown
## Visual evidence

Before/after from two real builds — `main` and this branch — same screens, same
steps. **No need to run the app.**

**→ [Open the gallery](https://github.com/<owner>/<repo>/blob/<sha>/docs/evidence/<dir>/README.md)**

| screen | before → after |
|---|---|
| Vault and the footer, 320 | `statusline 99px, wrapped → 49px, one row` |
```

Link by commit SHA, not by branch name, so the gallery survives the branch
being deleted.

**Do not try to embed the images in the PR body itself.** The GitHub tooling
available here strips `!` from image embeds and wraps bare URLs in backticks —
a deliberate anti-injection measure — so a pasted `![alt](url)` renders as a
plain link at best. Verify whatever you post by reading the PR back and
checking the markup survived; a body that looks right in the tool call is not
evidence that it looks right on GitHub.

If a change is visible and you cannot capture it — the surface has no harness,
the flow needs a backend this environment lacks — say so plainly in the PR,
name what you could not show, and describe what you verified instead. Silence
reads as "there was nothing to see".
