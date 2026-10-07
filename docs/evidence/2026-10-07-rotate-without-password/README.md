# Rotating the vault key without inventing a password — before / after

[ADR 0180](../../adr/0180-vaults-are-sealed-by-passkey-not-password.md). Captured from two
real builds (base `origin/main`, then this branch) with
`apps/pages/scripts/capture-evidence.mjs`, on a vault sealed with a PIN (no master
password), walked the same way at 1280 × 800 and 390 × 844.

| Sheet | What it shows | Before → after |
|-------|---------------|----------------|
| `1280-rotate.png` | Settings › Security › Rotate compromised vault key | 1 field (`New master password`, 480 × 44) → 0 fields; "the password entered becomes the master password" → "a new passkey opens it"; Rotate is enabled with nothing typed |
| `390-rotate.png` | Same sheet, phone | 1 field (322 × 44) → 0 fields |

The sheet still names what the rotation removes (`Removed PIN`). A browser that
cannot make a passkey is asked for a new PIN instead; a vault that holds a master
password still proves it. Both are covered by `VaultKeyProtectionPanel.rotate.test.tsx`.
