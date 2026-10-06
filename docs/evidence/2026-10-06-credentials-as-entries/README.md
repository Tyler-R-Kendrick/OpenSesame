# Credentials are entries of their own, bound to an account

Evidence for ADR 0179. Each pair is captured from the base build (`origin/main`)
and from this branch, walked the same way, at phone (390) and desktop (1280)
width. In a fresh guest vault with Account switched on:

| Sheet | What it shows |
|-------|---------------|
| `*-types.png` | Settings › Vaults › Item types: 23 packs where there were 18, the credential types each a switch of their own, and Password held on beside Accounts (`1 of 18 on` → `2 of 23 on`) |
| `*-picker.png` | The `+` on a new account: five choices before (84, 76, 60, 60 and 123 px wide keys), only Password after (one 84 px key) |
| `*-picker-on.png` | After API key and Token are switched on: Password, API key, Token; no OAuth, no Authenticator |
| `*-credential.png` | `/vault/new/api-key`: "Unknown item type" before; after, the API header and `X-Api-Key value` lines, the Account it opens (None), `.method` 358x176 at 390, 640x121 at 1280 |
| `*-credential-detail.png` | The saved credential: the account it opens or None, the header row, the value row (copyable, hidden) |

The vault rail grows `api-keys`, `passwords` and `tokens` directories for the
types switched on.
