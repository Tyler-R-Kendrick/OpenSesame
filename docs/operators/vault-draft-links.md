# New-item links and generated defaults

A link opens a reviewable draft; it does not create an account or save an item.
Use the installed item type as the final path segment:

```text
https://your-vault.example/vault/new/login?name=Example&username=public_alias&uri=https%3A%2F%2Fexample.com
```

For a path-hosted deployment, retain its base path before `vault/new/login`.
Supported query parameters are `name`, `username`, `uri`, `folder` (existing
folder ID), and `ref` (connection reference). Values are at most 120 characters;
typed items also accept `field.<id>` for declared scalar text, URL, number,
boolean, select and country fields (for example, `field.engine=postgresql` on
`/vault/new/database`). Concealed, multiline and personal-record fields are not
accepted. A value must match its field type and declared select options.
the whole encoded query is at most 2048. Parameters must occur once. Unknown or
invalid parameters refuse the entire prefill and show an explanation. URLs may
use HTTP/HTTPS but not embedded credentials, query strings or fragments.

Only publish values intended to be public. Never put a password, token,
authenticator seed, private key, confidential username or secret-bearing URL in a
link. Invalid secret parameters are not imported, but cannot be erased from
hosting logs or browser history after a caller has already sent them.

Missing names and aliases are generated locally. Passwords/custom secrets use
the existing 20-character cryptographic generator; manifest PIN fields use six
random digits. These remain concealed and editable. Generated credentials are
not provisioned at an external service. Keys, certificates, existing account
facts and authenticator enrollment must come from their actual ceremonies.

“Suggest names on device” uses the browser's Prompt API model. The preview
names the only context it uses: type and, when valid, website origin. Existing
form values never enter it. The user must press “Use names” to replace labels.
The button discloses that the browser may download its model. Preparation
requires that explicit click and browser user activation; no page-load or link
triggers it. Unsupported browsers keep the defaults without a remote fallback.
Agent calls require an already-ready model and cannot start a download.

Chrome WebMCP clients can call:

```json
{"name":"opensesame_vault_item_write","arguments":{"action":"suggest","kind":"login","source":"browser","url":"https://example.com"}}
```

Use `source: "random"` for offline aliases without inference. Both return only
`name`, `username`, `status` and `source`, never generated credentials. To open a
prefilled form, call `opensesame_navigate` with `section: "/vault/new"`,
`itemType: "login"` and a `prefill` object using the query vocabulary above.
