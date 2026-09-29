# @opensesame/browser-extension-autofill

The **optional** companion extension that fills a focused login field by
reference ([ADR 0150 §6.4](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md)).
It is the `browser-autofill` plugin in
[`spec/plugins/catalog.json`](../../spec/plugins/catalog.json) (§7): never part
of the default extension ([`apps/browser-extension`](../browser-extension),
whose manifest and bundle carry no fill code and no extra permission), never
installed unless a person installs it, and off until they switch it on. A
person who does not want autofill carries none of this code.

## What it can and cannot do

| | |
|---|---|
| **Manifest** | `storage`, `scripting`, `activeTab`, one keyboard command. **No `content_scripts`. No `host_permissions`** — every host, the daemon's loopback included, is an `optional_host_permissions` entry. |
| **Switching a site on** | The popup's site switch asks the browser for exactly the site in view (and the daemon's loopback host) on the person's own click. Only then is the guard registered for that host with `scripting.registerContentScripts`, top frame only. Switching off unregisters it and gives the grant back. A grant taken back in the browser's settings switches the site off here too. |
| **Starting a fill** | Only a gesture on extension-owned UI: the popup's fill key or the keyboard command (`Alt+Shift+O`). Never an overlay in the page, never on load. |
| **The guard** (`entrypoints/fill-guard.ts`, `lib/fill/guard.ts`) | Pure decision over facts it reads: top frame only; `location.origin` exactly the origin the background read from the tab; a focused username or current-password field that is enabled, non-zero in size, `visibility: visible`, not faded out through any ancestor, inside the viewport, and the element `elementFromPoint` finds at its own centre (the DOM-based extension clickjacking case, Tóth, DEF CON 33). Passkeys first: a field or form offering `autocomplete="webauthn"` gets no password, and the popup says a passkey is available. It checks again after the round trip before writing. |
| **The background** (`lib/fill/service.ts`, `lib/fill/admit.ts`) | Arms one single-use nonce per gesture and re-checks what the browser — not the page — says about the sender: this extension, `frameId === 0`, the armed tab, the exact armed origin, and the site still switched on. |
| **The value** | Asked of the daemon (`POST /v1/fill`) for one field of one entry, and only when that entry declares exactly this origin. It appears only in the single background → guard reply; it is never logged, stored, cached or shown to the popup. |

Residual, stated in the ADR: page JavaScript can read a value after it is
filled. An extension cannot close that; passkeys can.

## The daemon side

`crates/daemon/src/fill/`: `POST /v1/fill`, `/v1/fill/match` (entry names,
never values), `/v1/fill/pair` and the operator's `/v1/fill/pair/approve`,
`/v1/fill/pair/revoke`, `/v1/fill/pairings`. Every one of them answers only
while `plugin-settings` reports `browser-autofill` **active**; otherwise the
daemon answers exactly as for a path it never served (404, no body, every
method). A caller must address loopback, carry this extension's own `Origin`,
and present the pairing token a person approved; fills are rate limited per
extension.

## Build and install

```bash
pnpm --filter @opensesame/browser-extension-autofill build   # .output/chrome-mv3/
pnpm --filter @opensesame/browser-extension-autofill zip     # .output/browser-autofill-0.1.0-chrome.zip
sha256sum apps/browser-extension-autofill/.output/browser-autofill-0.1.0-chrome.zip
```

1. Load `.output/chrome-mv3/` as an unpacked extension (or install the zip
   through your browser's managed-extension policy) and note the extension id
   the browser shows (`chrome://extensions`).
2. Record it with the plugin settings, pinned to the zip you built:

   ```bash
   opensesame plugins install browser-autofill \
     --from apps/browser-extension-autofill/.output/browser-autofill-0.1.0-chrome.zip \
     --sha256 <hex from sha256sum> --extension-id <id>
   opensesame plugins enable browser-autofill
   ```

   Installing records the plugin **off**; `enable` (or its switch in Settings ›
   Capabilities) turns it on. `OPENSESAME_PLUGIN_BROWSER_AUTOFILL=off` on the
   daemon forces it off whatever the file says; nothing in the environment
   turns it on.
3. Pair once: open the popup on any page, press the pairing key, and approve
   the code it shows from a terminal on the same computer:

   ```bash
   OPENSESAME_OPERATOR_TOKEN=… opensesame daemon fill approve ABCD-EFGH
   opensesame daemon fill pairings            # paired origins, never tokens
   opensesame daemon fill revoke chrome-extension://<id>
   ```

4. On a login page, press the site switch in the popup and accept the
   browser's prompt for that one site. Focus the username or password field
   and press the fill key or `Alt+Shift+O`.

Entries are read from the sealed store (`opensesame pass`); an entry matches a
page only through a `url:` line with exactly its scheme, host and port.

## Develop

```bash
pnpm --filter @opensesame/browser-extension-autofill dev        # wxt dev
pnpm --filter @opensesame/browser-extension-autofill typecheck  # wxt prepare + tsc
pnpm --filter @opensesame/browser-extension-autofill test       # vitest + node:test pacts
```

`tests/placement.test.mjs` pins where the code lives (no content script, no
standing host permission, no overlay, nothing in the default extension);
`tests/capability-parity.test.mjs` holds the background's messages to the
`browser-autofill` rows of
[`packages/capability-registry`](../../packages/capability-registry), which
exclude every agent surface: a model never triggers a fill.
