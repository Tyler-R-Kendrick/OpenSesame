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
| **The guard** (`entrypoints/fill-guard.ts`, `lib/fill/guard.ts`) | Pure decision over facts it reads: top frame only; `location.origin` exactly the origin the background read from the tab; a focused username or current-password field that is enabled, non-zero in size, `visibility: visible`, not faded out through any ancestor, inside the viewport, and the element `elementFromPoint` finds at its own centre (the DOM-based extension clickjacking case, Tóth, DEF CON 33). Passkeys first: a field or form offering `autocomplete="webauthn"` gets no password (the search is the field's form, else the outermost shadow host it sits under, else its document, and it enters every shadow root below that scope, so a passkey field in a web component counts beside a form or a form-less light-DOM field; a field under a different top-level host is not beside it; a slotted field is faded by the wrappers it is slotted into, and one whose slot assignment cannot be observed — a light-DOM child of a host with a closed root, found through `browser.dom.openOrClosedShadowRoot`, and for a custom element that exposes no open root where that API is absent — is refused as `covered`, because the wrappers that fade or cover it are out of sight), and the popup says a passkey is available. It checks again after the round trip before writing. |
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
page only when a `url:` line (or a `uris` entry of an account the vault wrote)
has exactly its scheme, host and port.

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
`tests/e2e-wiring.test.mjs` keeps the browser suite below out of `pnpm test`.

## Browser end-to-end suite

```bash
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/browser-extension-autofill test:e2e   # wxt build, then e2e/*.e2e.mjs
pnpm test:e2e                                                     # the repository aggregation (turbo)
```

`pnpm test` never needs a browser. `test:e2e` builds the extension and loads
that build, unpacked, into a real Chromium in its new headless mode (extensions
do not run in the headless shell; without `PLAYWRIGHT_CHROMIUM` it falls back
to `/opt/pw-browsers/chromium`, then to Playwright's `chromium` channel). It
also binds `127.0.0.1:18790`, the daemon port the extension is built to call,
so stop a running daemon first; the suites run one at a time for that reason.

| Piece | What it is |
|---|---|
| `e2e/harness/daemon-stub.mjs`, `daemon-admission.mjs` | A stub of the daemon's fill routes (`/v1/fill`, `/match`, `/pair`) that applies the daemon's own admission rules in its order: plugin gate, loopback `Host`, `chrome-extension://` `Origin`, pairing token per origin, exact-origin entries. It logs routes and statuses, never a value. |
| `e2e/harness/sites.mjs` | The pages: one loopback listener reached as `app.test`, `frame.test` and lookalike hosts (`--host-resolver-rules` maps `*.test`), so a page, a cross-origin frame and a lookalike are real origins. |
| `e2e/harness/cdp.mjs`, `popup.mjs` | Drives the **real** toolbar popup (`chrome.action.openPopup()`), attached over the browser's debugging port. Playwright does not surface it, and `popup.html` opened as a tab does not do: the background refuses a sender with a `tab` as `forbidden_sender`. Every click is a real input event. |
| `e2e/fill.e2e.mjs` | Switch on, pair (code read off the popup, approved on the stub's operator channel), fill password and username, the registered-guard path, switch off; and that a page hooking `HTMLInputElement.prototype.value` and the field's own `value`, the console, the popup, `chrome.storage` and the network never see the value. |
| `e2e/refusals-field.e2e.mjs` | `opacity:0` on the field and on an ancestor, an overlay above it, an off-screen field, an overlay or a focus change (to another kind of field and to another of the same kind) while the value is in flight, a cross-origin and a same-origin frame, a new-password field, an `autocomplete="webauthn"` page (the popup reports the passkey, nothing fills), the same inside open shadow roots (form-less sibling, form, nested root, a root below the field's own, a web component inside its form or beside a form-less light-DOM field; a passkey field under another top-level host does not count), and a field slotted into a closed root, faded or not (refused: its wrappers cannot be read). |
| `e2e/refusals-origin.e2e.mjs` | Lookalike origins (prefix, suffix, subdomain, scheme, port, non-canonical) refused by the daemon by name, a page that tries to message the extension or the daemon, a daemon with the plugin off. |
| `e2e/manifest.e2e.mjs` | The shipped manifest with no grant: no content script, no host permission, the tab's address unreadable, the guard cannot be injected, the daemon's loopback unreachable. |

**What headless cannot do, and the stand-in.** The site switch calls
`permissions.request`, whose browser prompt no automation can press in
headless mode (the promise never settles), and the toolbar click that grants
`activeTab` cannot be made either. So the fill suites load the same build from
a temporary copy whose manifest adds the two grants a person's "Allow" would
give (`http://*.test/*` and the daemon's `http://127.0.0.1/*`) as
`host_permissions`; a request for a host already held resolves at once, and
everything after it is the shipped code: the popup's switch, the background's
registration, the guard, the checks, the daemon round trip. The build under
`.output/` is never modified, and `manifest.e2e.mjs` runs it byte for byte.
Two consequences: the browser refuses to give back a grant the manifest holds,
so the site switch's *off* is asserted on the registration and a fresh popup
rather than on the first popup's mark; and the keyboard command
(`Alt+Shift+O`) is not driven, because a browser shortcut does not travel over
DevTools input, so it stays covered by `lib/fill/service.test.ts`.

Each refusal test was run against a build with its check removed (opacity,
hit test, the second look after the round trip, the identity of the focused
field, passkey) and fails there.
