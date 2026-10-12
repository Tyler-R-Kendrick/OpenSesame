# C3 / F10 — live host item picker uses listedItems

Gallery for squash-merge #1049 (`fix(pages): live host item picker uses listedItems (F10)`). Link this folder from follow-up PRs under **Visual evidence** by commit SHA when touching the same surface.

| Sheet | What it shows |
|-------|----------------|
| `live-items-1280.png` | Live session host form at desktop width with the item picker open |
| `live-items-390.png` | Same picker at phone width |

**Before:** The live host item picker could offer vault items that were hidden or in the trash.  
**After:** The picker lists only `listedItems(activeItems(...))` — the same set a person sees in the vault listing.

Captured with `apps/pages/scripts/capture-evidence.mjs` and `PLAYWRIGHT_CHROMIUM` pointing at the Playwright chromium build on this VM (`journey.json` in this directory).
