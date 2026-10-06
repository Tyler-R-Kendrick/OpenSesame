# An account can always take a credential

Evidence for the follow-up to ADR 0179. Each pair is captured from the base
build (`origin/main`, which had the defect) and from this branch, walked the
same way, at phone (390) and desktop (1280) width, in a fresh guest vault with
Accounts switched on.

The defect: the `+` on an account's Login methods was drawn only when a
credential type was switched on, so a vault with none (Accounts on, Password
off, as one made before Password was a pack is) could neither add a credential
nor bind one. A guest vault cannot reach that state through Settings (switching
Accounts on switches Password on), so the first sheet shows the base's
narrowest offer; the state itself is held by `CredentialEditor.test.tsx` and
`watch.test.ts`.

| Sheet | What it shows |
|-------|---------------|
| `*-editor.png` | The account editor: the `+` on Login methods, 44x44 at 330,488 (390) and 1208,248 (1280), the same before and after in this vault |
| `*-picker.png` | What the `+` offers: Password alone before (one 84 px key); after, Password, API key, Token, OAuth and Authenticator (84, 76, 60, 60 and 123 px keys), a type that was off switched on by being chosen |
| `*-existing.png` | A credential kept on its own: before, no way to bind one (`.method__existing` none); after, it sits on a row of its own under the types (146x44 key at 16,648 on the phone, 612,359 on desktop) and, chosen, is bound in the same save |

Also held by `J-CREDENTIALS` in `verify:experience-journeys`, which walks the
real app: Accounts alone → the `+` and its five types → an account saved with
an API key of a type it had to switch on → a credential written on its own →
a second account taking it from under the `+` → two API key entries in the
vault, not three, and none left unbound.
