# Connector pages on a device with no Host: they act, or are not drawn

Two real builds walked the same way as a guest on the static deployment
(`capture-evidence.mjs`, journey in [`journey.json`](journey.json)): **before**
is `a04ceb7e`, built in its own worktree and captured with `EVIDENCE_DIST`;
**after** is this branch. Every number below is printed by the browser during
the capture (`count`, `values`, `labels` steps), not read from the diff.
Decision: [ADR 0151](../../adr/0151-connector-pages-act-on-the-roads-a-device-has.md),
building on [ADR 0150](../../adr/0150-settings-rows-act-or-are-absent.md).

| Sheet | What it shows |
|---|---|
| [`1280-capabilities-top.png`](1280-capabilities-top.png) | Settings › Capabilities as a guest, top of the page |
| [`1280-capabilities-lower.png`](1280-capabilities-lower.png) | Cloud secret storage, Password managers, Local storage |
| [`1280-better-auth-typed.png`](1280-better-auth-typed.png) | Better Auth with values typed |
| [`1280-better-auth-saved.png`](1280-better-auth-saved.png) | The same page after pressing Save |
| [`390-capabilities-top.png`](390-capabilities-top.png) | Capabilities at 390 × 844 |
| [`390-better-auth-saved.png`](390-better-auth-saved.png) | Better Auth after Save at 390 × 844 |
| [`1280-vault-encryption.png`](1280-vault-encryption.png) | Encryption with a sealed password vault |
| [`1280-workos-unsealed.png`](1280-workos-unsealed.png) | WorkOS before its Connect credential is sealed |
| [`1280-workos-failed.png`](1280-workos-failed.png) | WorkOS, credential sealed, Create pressed with no network |

## Measurements

| | Before | After |
|---|---|---|
| **Guest, desktop and phone** — `.capsection__title` subheaders | 14 | 11 |
| **Guest** — connector tiles (`a.conn-tile__link`) | 48 | 14 |
| **Sealed vault** — subheaders / tiles | 16 / 48 | 14 / 18 (Encryption keeps its four) |
| **Better Auth after Save** — fields | `base_url=filled, api_key=filled` → `empty, empty` (the typed values wiped) | 0 fields, 0 keys, 0 panels |
| **Better Auth after Save** — feedback | one ✗ at the top of the page, label "This browser has no approved grant for that action."; bell none | no key to press; mark "Not available here" |
| **Better Auth** — fields / keys / panels drawn | 4 / 1 / 1 | 0 / 0 / 0 |
| **WorkOS before a credential** — `#connector` panels / keys / disabled keys | 1 / 1 / 1 | 0 / 0 / 0 |
| **WorkOS, Create fails with no network** — bell | "Notifications — none", 0 attention keys | "Notifications — 1 pending", 1 attention key |

The 14 tiles that remain each have something to do: WorkOS and Auth0 (Connect
panels), the git family and GitHub (browser-local), password-store (its
vault-history switch), Doppler, Hugging Face, Anthropic, OpenAI, OpenRouter
(Connect panels). The 34 that went: 30 whose only road is a Host, and the four
keys (YubiKey, AWS KMS, Azure Key Vault Keys, Google Cloud KMS) that seal in an
unlocked vault and drew an empty Connect panel for a guest.

## What could not be captured, and what was checked instead

The save-failure behaviour of the Host forms (typed values kept, the ✗ beside the
key that was pressed, the sentence in the bell, a retry sealing into the
connection the failed try made) is reachable only where a Host road is open. No
Pages build opens one (no pairing ceremony, ADR 0128), so it cannot be walked
from a real build. It is held by unit tests that fail on `a04ceb7e` and pass here
(`ConnectForm.save.test.tsx`), and was seen once in the attached dev session
with the Host road opened through the same seams the tests use and a Host that
answers 403: fields kept, ✗ in the key's own row, bell "1 pending" with the
provider's name and the sentence.
