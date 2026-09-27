# Reset this browser, from the lock screens

These are before/after captures from two real builds, `main` at `2338c69c` and
this branch, walked the same way with
`apps/pages/scripts/capture-evidence.mjs` and [`journey.json`](journey.json).
Every measurement was read from the browser during the capture.

The change adds "Reset this browser?" to the front door, the unlock form and
the vault list. Confirming it signs out, then clears every store the app keeps
on the origin: origin-private files, IndexedDB, local and session storage,
Cache API caches and service workers. It then loads the app root as a first
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
