# A credential is one line, like a website

Evidence for the account editor's credential lines and the detail page's API key
rows. Each pair is captured from the base build (`origin/main`) and from this
branch, walked the same way, at phone (390) and desktop (1280) width.

| Sheet | What it shows |
|-------|---------------|
| `1280-password.png`, `390-password.png` | A new account's password: one line, the keys inside its rule, the × at the end of the line, like the Websites line |
| `1280-options.png`, `390-options.png` | The generator's options open from a key on the password's line |
| `1280-editor.png`, `390-editor.png` | An API key (API header, then `X-Api-Key value`) and a token added |
| `1280-detail.png`, `390-detail.png` | The saved account: API header and its value as separate copyable rows |

Measured in the browser (`getBoundingClientRect`, same walk on both builds):

| Measure | Before | After |
|---------|--------|-------|
| 1280, password block (`.method`) | 640x562 | 640x61 |
| 1280, saved account (`.detail`) | 696x836 | 696x672 |

At 390 the password block after the change is 358x89 (one line, closed) and 358x604 with the options open.
