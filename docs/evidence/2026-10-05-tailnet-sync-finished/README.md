# Tailnet sync, finished — visual evidence (2026-10-05)

Before: the base build (`5afc01e6`, `origin/main` when this branch last merged
it). After: this branch. Both builds were walked the same way by
`apps/pages/scripts/capture-sync-evidence.mjs` at 1280×900 (desktop) and
390×844 with a coarse pointer (phone), against the real `opensesame` daemon
behind a TLS proxy at `desk.tail4c2e.ts.net`, with Chrome's Local Network
Access check on. Each sheet's caption is what the browser measured, and the
raw numbers are in `before-measurements.json` / `after-measurements.json`.

| Sheet | What it shows | Measured |
|-------|---------------|----------|
| [capabilities-desktop](capabilities-desktop.png), [capabilities-phone](capabilities-phone.png) | Settings › Capabilities: a **Breach and two-step checks** section after Environments | sections 15 → 16; section present false → true |
| [checks-desktop](checks-desktop.png), [checks-phone](checks-phone.png) | That capability on, two logins saved (GitHub with the password `password`, Shop with a unique passphrase), Settings › Vaults, its key pressed. Have I Been Pwned and 2fa.directory are answered from fixtures in the shape the real services answer | before: no switch, no panel. After: head mark "1 of 2 passwords found in breaches"; GitHub row: "Found in breaches 9,545,824 times: change this password" and "This site takes an authenticator code; none is stored"; Shop: no row |
| [waiting-desktop](waiting-desktop.png), [waiting-phone](waiting-phone.png) | A sealed vault paired with the drive, Chrome's local-network permission still at "ask", an item saved, 20 s later | panel mark "Failed to fetch" → "Sync is waiting for local network access. Sync now, and allow it when the browser asks." (a warning glyph, not an error) |

Not shown because nothing on screen changed: field-level merge, password and
project propagation, attachments over the drive and the CLI. Their proof is
the test suites and `verify:tailnet-sync` (TS-FILE downloads a file sealed on
the other device, byte for byte) listed in ADR 0144 § Proof.
