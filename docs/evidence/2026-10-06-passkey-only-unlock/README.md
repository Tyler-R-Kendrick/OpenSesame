# Passkey-only sealing — before / after

A new vault is sealed with a passkey (or a PIN where WebAuthn cannot run), never
a master password — [ADR 0180](../../adr/0180-vaults-are-sealed-by-passkey-not-password.md).
Captured from two real builds (base `origin/main`, then this branch) with
`apps/pages/scripts/capture-evidence.mjs`, walked the same way at 1280 × 800 and
390 × 844. The measurements come from the browser (`measure` steps in `journey.json`).

| Sheet | What it shows | Before → after |
|-------|---------------|----------------|
| `1280-seal.png` | First-run "Seal this device" | 3 method tabs → 2 (Passkey, PIN); no Password tab. Release-notes line reads "Unlock with a passkey or PIN". |
| `390-seal.png` | Same form, phone | 3 tabs (76, 45, 84 px wide) → 2 (76, 45); every tab stays 44 px tall |
| `1280-security.png` | Settings › Security › Unlock methods | 3 key rows (67, 67, 66 px) → 2 (67, 66) |
| `390-security.png` | Same list, phone | 3 key rows → 2 |

An existing vault that already holds a password wrap still shows its Password
tab at unlock and a Remove-only row in Settings; that state is covered by
`UnlockMethodsPanel.password.test.tsx` and `UnlockScreen.test.tsx`, not here.
