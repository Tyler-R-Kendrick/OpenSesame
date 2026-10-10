# C2 / F5 — claim route different link

Gallery for PR #1051 (`cursor/persona-r3-c2-claim-different-link-b5a1`). Link this folder from the PR under **Visual evidence** by commit SHA.

| Sheet | Measurement |
|-------|-------------|
| `claim-route-1280.png` | statusline 1280×53 @0,847 |
| `claim-route-390.png` | statusline 390×56 @0,788 |

**Before:** A bad claim link left the guest with no way back except the browser chrome.  
**After:** Claim route offers **Use a different link** to return to manual entry.

Captured with `apps/pages/scripts/capture-evidence.mjs` and `PLAYWRIGHT_CHROMIUM` pointing at the Playwright chromium build on this VM.
