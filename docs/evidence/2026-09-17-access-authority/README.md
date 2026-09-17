# Access › Sessions — hierarchical local authority (GA-P-02 / GA-Q-03)

Before/after from two real Pages builds walked the same way: guest → Access →
Sessions tab (`role=tab`). Phone 390×844 and desktop 1280×800.

| Sheet | Before | After |
|---|---|---|
| `390-access-sessions.png` | Sessions opens on **Vault share sessions** only | **Local sessions & grants** + **Audience templates** above vault sessions |
| `1280-access-sessions.png` | Same — vault share sessions alone at the top of Sessions | Same panels present; template row shows `Family / shared devices (v1.0.0)` |

## What this proves

- Access surfaces the local share-grant ledger (`LocalAuthorityPanel`) and
  audience templates (`LocalAuthorityTemplates`) on Sessions — one ledger
  (INV-GA-10), not a second AccessLease UI.
- Panels are visible with no Host configured (`Connect Host` still offered).

## How

`journey.json` in this directory. Chromium via
`PLAYWRIGHT_CHROMIUM` (harness `press` step also matches `role=tab`).
