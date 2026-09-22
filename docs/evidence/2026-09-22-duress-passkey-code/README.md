# Visual evidence — duress passkey-then-code

Branch work wires passkey-then-code unlock and a presentation shell. The
passkey code step itself needs WebAuthn/PRF hardware, so these sheets prove
the guest road and front-door composition still hold after the unlock chrome
changes.

| Sheet | Claim |
| --- | --- |
| `390-front-door.png` | Phone front door still shows guest continue |
| `390-guest-vault.png` | Guest continue still opens the vault shell at 390 |
| `1280-front-door.png` | Desktop front door still shows guest continue |
| `1280-guest-vault.png` | Guest continue still opens the vault shell at 1280 |

Captured with `apps/pages/scripts/capture-evidence.mjs` against base
`origin/main` merge-base and this branch, Chromium from the local Playwright
cache.
