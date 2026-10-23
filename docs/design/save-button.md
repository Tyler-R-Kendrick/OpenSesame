# Save in OpenSesame

A website can add one element that lets a visitor save a login, card or crypto
wallet to their OpenSesame vault. Comparable to
[Save in 1Password](https://www.1password.dev/web/add-1password-button-website),
but the static PWA is the receiver, so no backend and no browser extension are
required.

## Flow

```text
Website                         Unlocked OpenSesame vault
  |                                      |
  | click "Save in OpenSesame"           |
  |------------------------------------->| popup /save
  |                                      |
  |<--- {type: save.ready} --------------|
  |--- {type: save.request, base64} ---->|
  |                                      | decode + review sheet
  |                                      | person presses Save
  |<--- {type: save.saved, itemId} ------|
```

- The payload lives in the button's `value` attribute. It is Base64 JSON, not
  a URL, localStorage, cookie or request body.
- The button opens the vault in a popup. Nothing is sent to a server.
- The vault announces readiness; the button sends the request only to the
  exact vault origin.
- The person reviews every field. Nothing is saved on load or by the site.
- If the vault is locked, the normal unlock gate shows first. The request waits
  in popup memory; closing the popup discards it.
- Save writes one item and returns its id to the page.
- The login item's URL is the origin that presented the button. A page cannot
  claim another site's domain.

## Host page

```html
<script type="module" src="https://vault.example/save-button.js"></script>

<opensesame-save-button
  data-opensesame-type="login"
  vault-url="https://vault.example"
  value="<base64 save request>">
</opensesame-save-button>
```

Build the value with the module's encoder:

```js
import { encodeSaveRequest } from "https://vault.example/save-button.js";

const value = encodeSaveRequest({
  title: "Example",
  fields: [
    { autocomplete: "username", value: "ada@example.test" },
    { autocomplete: "current-password", value: "correct horse" },
  ],
  notes: "Saved from the account page.",
});
```

Supported `data-opensesame-type` values:

| Type | Fields |
|---|---|
| `login` | `username`, `current-password` or `password`, `one-time-code`, optional `url` (ignored for the item's domain) |
| `credit-card` | `cc-name`, `cc-number`, `cc-exp`, `cc-csc`, `cc-type`, address autocomplete fields |
| `crypto-wallet` | `crypto-address`, `crypto-recovery-seed` |

The `crypto-wallet` item type is installed on first use if the deployment has
its pack. If the pack cannot be installed, the review sheet refuses the save
rather than storing a misleading secret.

## Security

- The request is validated in the vault: bounded length, bounded field count,
  UTF-8 JSON, no unknown shape, no empty title.
- The popup accepts a message only from `window.opener`, and the button accepts
  a reply only from the configured vault origin.
- The request is not stored by the button or the vault before Save.
- Secrets are concealed in the review sheet until the person reveals them.
- No field value is logged, placed in a URL, or sent to a backend.
- Closing the popup, cancelling, or a failed save leaves the vault unchanged.
- Login item URIs use `event.origin`, not a page-supplied URL, so a page cannot
  create a login for another origin.
- The button does not use `innerHTML` and does not expose the request to the
  page after the popup closes.

## Limits

- Popup blockers must be allowed for the vault origin.
- The page must be able to load `save-button.js`; a strict CSP needs an
  allowance for that script and the shadow-DOM styles it creates.
- Saving requires the vault to be unlocked. There is no background save.
- There is no browser-extension injection in this version. A site adds the
  element itself; later, the autofill companion can offer the same request
  without a popup.
- API-key saves are not part of this flow. They need the partner/integration
  path and a different review form.
- A same-site page could offer a misleading title or notes. The source origin
  and every field are shown; the person remains the approver.

## Native/PWA split

- **PWA**: receiver at `/save`, review sheet, vault write, item creation.
- **Native**: no separate implementation. The same PWA receiver runs in the
  native shell; the payload still never reaches a backend.
- **Browser extension**: optional future acceleration; not required for the
  feature to work.

## Delivery slices

1. **Encoder and element.** Base64 schema, shadow-DOM button, popup handshake,
   saved event.
2. **PWA receiver.** `/save`, validation, review, login/card save.
3. **Crypto wallet.** Install the item type on first use, typed item creation.
4. **Tests.** Schema, item builder, handshake, cancel/error, origin binding.
5. **Extension path.** Optional fill/save companion for sites that prefer no
   popup.

## Acceptance

- A host page with the element and a login request opens the vault popup, sends
  the request, and saves only after the Save key.
- A malformed, empty, oversized or wrong-type request is refused before any
  item is created.
- A card request saves the brand, expiry and address notes.
- A crypto request saves a typed wallet item or refuses honestly when its pack
  is unavailable.
- A page on `shop.example` cannot make the saved login item belong to
  `bank.example`.
- No request value appears in a URL, cookie, localStorage, server log or model
  context.
- Closing or cancelling leaves the vault unchanged.
- The receiver works with no backend, no relay and no extension.
