# Hint captions removed (2026-10-07)

A `.hint` line is a fact, not a caption. `no-hint-caption` (`scripts/quality/design-lint-hints.mjs`)
now fails any hint of five words or more on every screen, and every one the rule found is gone.

Both builds walked the same journey (`journey.json`): guest, Settings › Vaults, switch the Account
pack on, open `vault/new/account`. The "before" is the base commit's build, the "after" is this branch's.
Measurements are `getBoundingClientRect` readings from the browser.

| Sheet | Before | After |
|-------|--------|-------|
| [`1280-new-account.png`](1280-new-account.png) | editor 458px tall; 38px explainer row under the wildcard address | editor 421px tall (−37px); no explainer row |
| [`390-new-account.png`](390-new-account.png) | editor 742px tall; 57px three-line explainer | editor 686px tall (−56px); no explainer row |

The wildcard/regex sentence now lives on the match-rule select's `title`.

Other screens changed by the same sweep (identity, access, connections, unlock, settings) drop caption
lines of the same kind; they have no sheet here because each only removes a paragraph beneath a control.
