# A1 / F6 — sent drops lockout and receipts

Gallery for PR #1044 (`cursor/persona-r3-a1-outbound-tomb-b5a1`). Link this folder from the PR under **Visual evidence** by commit SHA.

| Sheet | Measurement |
|-------|-------------|
| `sent-drops-1280.png` | statusline 1280×53 @0,847 |
| `sent-drops-390.png` | statusline 390×56 @0,788 |

**Before:** Outbound tomb drops could be revoked without the two-press pattern; sender lockout and receipt queue gaps remained.  
**After:** Two-press revoke, lockout while a drop is live, and queued receipts for sender decisions.

Captured with `apps/pages/scripts/capture-evidence.mjs` and `PLAYWRIGHT_CHROMIUM` pointing at the Playwright chromium build on this VM.
