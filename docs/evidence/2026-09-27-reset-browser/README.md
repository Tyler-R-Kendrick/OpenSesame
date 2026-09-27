# Reset this browser, from the lock screens

These are before/after captures from two real builds, `main` at `2338c69c` and
this branch, walked the same way with
`apps/pages/scripts/capture-evidence.mjs` and [`journey.json`](journey.json).
Every measurement was read from the browser during the capture.

The change adds "Reset this browser?" to the front door, the unlock form and
the vault list. Confirming it signs out, then clears what the app owns on the
origin, and nothing else: its origin-private files, its IndexedDB database, its
local and session storage keys, its Cache API caches and its service worker.
The origin is shared with every other GitHub Pages site of the account, so each
store is cleared by the app's own names (see the last section). It then loads the app root as a first
visit. When the device is offline it keeps the app shell (the service worker
and its caches, which hold only release assets), so the reload still loads. The vault list only appears with several vaults on the device, and this
journey doesn't set that up. Its placement is covered by `VaultsScreen.test.tsx`.

## Front door, 390 × 844 (touch)

![Front door foot](390-front-door.png)

Before, the card had no foot. After, it has `"Reset this browser?" 148×44 @121,484`.

![Front door, reset opened](390-front-door-reset.png)

After: panel `277×159 @57,484`, keys `44×44 @72,585` and `@124,585`.

## Unlock form beside a sealed vault, 390 × 844 (touch)

![Unlock form foot](390-unlock.png)

The guest link (`133×44 @53,396`) and the forgotten link (`187×44 @53,448`)
stay where they were. The reset link is added beneath them at `148×44 @53,500`.

![Unlock form, reset opened](390-unlock-reset.png)

After: panel `277×159 @53,500`, keys `44×44 @68,602` and `@120,602`. The guest
road stays on screen while the panel is open.

## Desktop, 1280 × 900 (mouse)

![Front door, desktop](1280-front-door.png)

![Unlock form, reset opened, desktop](1280-unlock-reset.png)

## What the reset did in a real browser

This was checked against `vite preview` of the branch build, with its service
worker and caches live. It is not part of the capture above.

| state | OPFS files | IndexedDB | caches | service workers |
|---|---|---|---|---|
| first visit | 3 | none | 1 | 1 |
| sealed vault, locked | 9 | `opensesame-history-backups` | 2 | 1 |
| after reset + reload | 3 | none | 1 | 1 |

After the reset the tab landed on `/OpenSesame/` showing the front door and the
guest road, with no console or page errors. A second tab that was open on
`/vault` reloaded itself to `/OpenSesame/`.

The same journey with the browser taken offline before the reset:

| state | OPFS files | caches | service workers | page controlled by the worker |
|---|---|---|---|---|
| sealed vault, locked, online | 9 | 1 | 1 | yes |
| after offline reset + reload | 3 | 1 (kept) | 1 (kept) | yes |

Offline, the reload still loaded the front door from the service worker, with
no page errors.

## When something is left behind (second review)

These two sheets come from the branch at `a156d6d9` (before) and after the
second review's fixes, walked with [`journey-left.json`](journey-left.json).
The earlier sheets above are unchanged. The journey seals a password vault,
opens the unlock form, takes the browser offline (`goOffline`), presses Erase,
then finds the reset panel wherever the build draws it (`lookForResetPanel`).

![Offline reset, phone](390-offline-reset-left.png)

Before, the tab stayed on `/vault` with the panel open (`168×127 @53,358`).
Its writes were halted and its memory still described the vault it had just
erased, so the unlock form went on offering `personal`. After, the tab always
leaves for a fresh document. What was left comes along in the address and is
taken off it on arrival. The front door lands on `/OpenSesame/` and shows it
first, above the roads in: the notice is `324×127 @33,78` and the roads are
`@33,310`. Each area left has one `StatusMark` row (`Offline app: kept while
offline`, `Offline worker: kept while offline`, `294×20 @48,92` and `@48,118`).
The two keys are `Erase again` and `Dismiss` (`44×44 @48,147` and `@100,147`).
A store that refused shows an error mark reading `<area>: not erased`. While
the reset runs, the app is not drawn at all: one status reads "Resetting this
browser", so no lock-screen control can be pressed.

![Offline reset, desktop](1280-offline-reset-left.png)

Desktop: the notice is `480×115 @109,187` above the roads at `@109,418`, and
the keys are `32×32` and `24×24`.

## Only what the app owns: the fixed build in a real browser

Checked against `vite preview` of the branch build at
`http://localhost:4188/OpenSesame/`. Another site's data was seeded on the same
origin first:

- a localStorage key, and `opensesame-docs.theme` (named like ours);
- in the app's own tab, a sessionStorage key, a relying-party SDK session
  (`opensesame:session`) and another site's MSAL key
  (`msal.3.token.keys.<their client>`);
- two caches, one named like ours but under `/other-site/`;
- an IndexedDB database and an OPFS file;
- a service worker at another scope. A worker script cannot be routed, so
  it came from a temporary file at `/OpenSesame/other-site-sw.js`, registered
  with scope `/OpenSesame/other-site/`.

The app then got a guest vault (14 OPFS files, 7 of them its tomb), its own
worker and cache, `opensesame-history-backups` and its own keys. A second tab
was open on the app.

| variant | while resetting | app data after | app cache / worker | the other site's data (10 items) |
|---|---|---|---|---|
| online | status only, 0 buttons | none | removed | **all survive** |
| offline | status only, 0 buttons | none but the fresh document's first-visit files | kept, and the notice says so | **all survive** |
| "online" but the probe is refused | status only, 0 buttons | none but the fresh document's first-visit files | kept, and the notice says so | **all survive** |

Online, the first-visit load was held on a placeholder page, so nothing a
first visit writes could be mistaken for leftovers. Both tabs reached it only
after the reset was over: the second tab waits on the reset's Web Lock. Offline
and with the probe refused, the kept worker served the fresh document. That
document writes three files of its own on arrival. The same three files
(`installation.v1`, `tombs.v1`, `tomb_personal_migrated.v1`) appear on a
pristine first visit. None of the erased vault's seven tomb files remained.
There were no page errors. The only console line is the refused probe
request itself, in the probe-refused variant.

