# A finger above 900px — 2026-09-14

Self-review evidence for PR #396. Captured from two real builds walked the
same way: `before` is the merge-base with `main`
(`20d3c0fbbc39384d332a8882d12ed79135fa79d5`), `after` is this branch.

These pairs are meant to **match**. That is the claim. The branch rebuilt the
phone's chrome, and twice in doing so it reached above 900px and broke the
arrangement a tablet gets, where there is no top bar and the status strip is
the whole of the chrome:

1. `@media (pointer: coarse), (max-width: 900px) { .statusline { display: none } }`
   — the strip's only replacement is the top bar, and that is `display: none`
   above 900px. A tablet in landscape matched the first half of the rule and
   neither half of the replacement: rail, and no support, notifications, plane
   truth, keymap or overflow key at all.
2. The 44px floor this file already carried for `(pointer: coarse),
   (max-width: 900px)` was deleted as dead code — below 900px the strip is
   hidden, so sizing it reads as dead. The rule was two conditions and only one
   of them had died; seven 28px keys were left under a thumb.

Both are restored. `pnpm --filter @opensesame/pages verify:mobile` now walks
two tablet contexts after the four phones; its tablet stop fails 8 checks
without the fix and passes with it.

| Sheet | What it shows | Measured |
|-------|---------------|----------|
| `1366-tablet-vault.png` | Tablet landscape, coarse pointer | strip 53px, seven keys 44 × 44, both sides |
| `1024-tablet-vault.png` | Tablet portrait, coarse pointer | strip 53px, seven keys 44 × 44, both sides |
| `1280-mouse-vault.png` | Desktop, real mouse | strip 40px, seven keys 28 × 28, both sides |

Numbers are read from `getBoundingClientRect()` in each build, not from the
images. The pane-level differences visible in these sheets — no repeated
`Vault` heading, `personal:/` once per pane instead of twice — are this
branch's intended change, evidenced in
[`2026-09-14-one-bar/`](../2026-09-14-one-bar/README.md).

## Reproducing

```bash
J=docs/evidence/2026-09-14-tablet-chrome/journey.json
git checkout "$(git merge-base HEAD origin/main)" -- apps/pages/src
git diff --name-only --diff-filter=A "$(git merge-base HEAD origin/main)" HEAD -- apps/pages/src \
  | while read -r f; do git reset -q HEAD -- "$f" && rm -f "$f"; done
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages --force
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"
git checkout HEAD -- apps/pages/src
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages --force
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```
