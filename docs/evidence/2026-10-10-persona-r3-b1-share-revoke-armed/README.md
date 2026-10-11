# B1 / F7 — share revoke armed state

Gallery for PR #1042 (`cursor/persona-r3-b1-share-revoke-armed-b5a1`). Link this folder from the PR under **Visual evidence** by commit SHA.

| Sheet | Measurement |
|-------|-------------|
| `share-grants-1280.png` | statusline 1280×53 @0,847 |
| `share-grants-390.png` | statusline 390×56 @0,788 |

**Before:** Revoke on an identity share grant did not show the armed (confirm) state.  
**After:** Revoke arms like other irreversible identity actions before it executes.

Captured with `apps/pages/scripts/capture-evidence.mjs` and `PLAYWRIGHT_CHROMIUM` pointing at the Playwright chromium build on this VM.
