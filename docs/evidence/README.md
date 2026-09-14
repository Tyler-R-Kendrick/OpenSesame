# Visual evidence

Before/after images for user-visible changes, one directory per change
(`<yyyy-mm-dd>-<topic>/`). They exist so a reviewer can see what a change did
to the interface without cloning the branch, installing, building and walking
the app.

Each directory holds:

- the composed sheets — one PNG per comparison, each a before and an after of
  the same screen with the measurement that makes the difference a fact;
- `README.md` — the sheets laid out in reading order with their captions. This
  is the page a pull request links to, because GitHub renders a repository
  Markdown file's relative images and will not render an image embed pasted
  into a PR body through a tool;
- `journey.json` — the screens visited, the steps taken to reach them, and the
  captions. It lives here rather than in the script because a caption that
  outlives its change is a caption nobody rechecks.

Both halves of every pair come from a real build: the base branch's for the
before, the branch's for the after, walked the same way. Nothing here is a
mockup and nothing is staged.

Regenerate a directory with `skills/visual-evidence/SKILL.md`:

```bash
J=docs/evidence/<dir>/journey.json
git checkout "$(git merge-base HEAD origin/main)" -- apps/pages/src
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"
git checkout HEAD -- apps/pages/src
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

Raw captures go to the system temp directory; only the composed sheets are
committed, and only enough of them to show one thing each.

| Directory | Change |
|---|---|
| `2026-09-14-mobile-declutter/` | The phone declutter — the five connector glyphs rolled into one overflow key, the vault's filter chips moved behind one key (PR #396) |
| `2026-09-13-mobile-touch/` | The phone layout and touch contract — the 44px floor on width as well as pointer, the 16px field floor, the one-row statusline, the landscape arrangement (PR #396) |
