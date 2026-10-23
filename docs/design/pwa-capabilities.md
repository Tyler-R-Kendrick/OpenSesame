# PWA capability review

Reviewed: 2026-10-22. Sources:

- [Powerful PWAs](https://chromeos.dev/en/web/powerful-pwas)
- [Desktop Progressive Web Apps](https://chromeos.dev/en/web/desktop-progressive-web-apps)
- [PWA checklist](https://web.dev/pwa-checklist/)
- [Web Capabilities tracker](https://goo.gle/fugu-api-tracker)

Status in those pages changes. This document records what OpenSesame has,
what it adopts, and what it deliberately refuses. Every adopted row is
implemented; a row marked **reject** is a product decision, not unfinished
work.

Legend: **done**, **partial**, **planned**, **defer**, **reject**.

## Baseline

| Capability | State | Evidence |
|---|---|---|
| Web App Manifest | done | `apps/pages/vite.config.ts` |
| Service worker + Cache Storage | done | `src/sw.ts`, `src/sw/*` |
| Offline shell and plan assets | done | `sw/core.ts`, `sw/plan-assets.ts` |
| Install prompt and persistence | done | `lib/install.ts` |
| PNG + SVG icons, maskable icon | done | `public/icon-192.png`, `icon-512.png`, `icon.svg` |
| App shortcuts | done | Vault, Access, Identity, Wallet, Settings in the manifest |
| Launch handler / link capture | done | `navigate-existing`, `handle_links: preferred` |
| Async Clipboard | done | vault copy helpers |
| Web Push | done | `sw-push.ts`, `notifications.web-push` |
| Badging API | done | `notifications.local/delivery.ts` |
| File System Access | done | `lib/file-system.ts` |
| Compression Streams | done | ZIP import and WASM gzip |
| Pointer input | partial | gestures and menus use pointer events; some touch-only paths remain |
| Direct Sockets | IWA only | `lib/direct-sockets.ts` |
| Local Peer-to-Peer | adapter | `lib/local-p2p.ts`; draft, not yet a live transport |
| Local Network Access | done | `lib/local-network-fetch.ts` |
| OPFS | done | `lib/kv.ts`, `lib/file-parts-store.ts`, `travel/storage.ts` |
| Web Locks | done | `lib/local-access-ledger-lock.ts` |

## Full review

### Installation and launch

| Feature | State | Decision | Plan |
|---|---|---|---|
| Web App Manifest | done | keep | Add screenshots and richer categories as assets exist |
| Service worker / Cache Storage | done | keep | Keep the plan-driven offline cache |
| Run on Login | — | defer | OS/enterprise policy feature; document rather than fake in the manifest |
| App icon shortcuts | done | keep | Add New item / Import when their query routes exist |
| `getInstalledRelatedApps` | — | reject | No Android/UWP companion app to relate |
| Install criteria / icons | done | keep | Raster 192/512 plus maskable and SVG |
| `launch_handler` | done | keep | Route launches into the existing window |
| `handle_links` | done | keep | Prefer the installed app for OpenSesame links |
| IWA target | done | keep separate | Signed bundle, Direct Sockets, no service worker |

### Adaptive and accessible

| Feature | State | Decision | Plan |
|---|---|---|---|
| Responsive design | done | keep | Existing rail/sheet adaptation |
| WCAG 2.2 | partial | keep | Continue keyboard, focus, contrast and target-size audits |
| Touch targets | partial | keep | Minimum 44px controls; audit new panels |
| Hover as enhancement | partial | keep | Keep long-press/tap alternatives where hover hides actions |
| Pointer Events | partial | adopt | Replace remaining touch-only handlers, notably tab-swipe |
| Desynchronized canvas | — | reject | No drawing surface where latency matters |
| Pinch/gesture support | partial | keep | Existing gestures; avoid gestures that conflict with browser zoom |

### Monetization and distribution

| Feature | State | Decision | Plan |
|---|---|---|---|
| Web Payments | — | reject | The vault does not sell through the app |
| Digital Goods API | — | reject | No in-app purchase catalogue |
| Trusted Web Activity | — | reject | The native shell is the CLI/daemon, not an Android TWA |
| PWABuilder packaging | — | defer | Useful only if a store wrapper is wanted |

### Clipboard

| Feature | State | Decision | Plan |
|---|---|---|---|
| Async Clipboard text | done | keep | Existing copy/reveal and timed clear |
| Clipboard images/files | — | defer | No item type needs binary clipboard yet |
| `copy`/`paste` events | — | defer | Write via the async API only |

### Notifications

| Feature | State | Decision | Plan |
|---|---|---|---|
| Web Push | done | keep | Existing opt-in, service worker, push subscription |
| Badging API | done | keep | Waiting requests count on the installed icon |
| Notification Triggers | — | reject | Not a stable cross-browser feature; no time/location trigger promise |
| Local notifications | done | keep | Existing in-app notice tray |

### Sharing and protocols

| Feature | State | Decision | Plan |
|---|---|---|---|
| Web Share | done | keep | Explicit Share action shares the item label only; a secret value is never put in the OS share sheet |
| Web Share Target | done | keep | `POST /share-target` stages one bounded file or shared text and opens Import review, never a direct vault write |
| URL protocol registration | — | reject | A `web+opensesame` handler would put item references in URLs and needs a hijack boundary with no product need |
| `launchQueue` | done | keep | File launches are read once and held for the existing Import review |
| Local Peer-to-Peer | adapter | pilot | Live sharing keeps WebRTC; LP2P is feature-detected and does not auto-connect |
| File Handling API | done | keep | `.kdbx`, `.1pux`, `.json`, `.env`, `.csv` open into Import review |
| File System Access | done | keep | Save/open pickers, OPFS attachment storage and a directory export |
| Directory read/write | done | keep | Encrypted backup can be written to a chosen directory; read/import stays review-first |

### Window management

| Feature | State | Decision | Plan |
|---|---|---|---|
| Fullscreen | — | defer | No media or presentation surface needs it |
| Cross-Screen Window Placement | — | reject | No multi-display canvas/window workflow |
| Tabbed Application Display Mode | — | defer | Revisit if the rail becomes true multi-document tabs |
| Window Controls Overlay | — | reject | The rail/header grid has no custom titlebar; overlaying controls would fight the existing chrome |

### Deeper OS integration

| Feature | State | Decision | Plan |
|---|---|---|---|
| Local Fonts | — | reject | Fingerprinting and no product need; the app ships its own type stack |
| Wake Lock | done | keep | Held only during a visible import/export; released on hide and on completion |
| Idle Detection | — | reject | The existing activity timer already locks on idleness without a new browser permission or a surveillance-shaped signal |
| Badging | done | keep | Existing |
| App icon shortcuts | done | keep | Existing |

### Offline and background

| Feature | State | Decision | Plan |
|---|---|---|---|
| Background Sync | — | reject | A service worker has no vault key; queuing useful work there would require plaintext or a false promise. The in-page sealed queue is authoritative |
| Periodic Background Sync | — | reject | No secret work may wake periodically, and the browser support is not a product contract |
| Content Indexing | — | reject | Item names, URLs and counts are vault metadata; do not surface them in the OS |
| Background Fetch | — | reject | The app has no large attachment transfer that can complete after the page closes, and the worker cannot hold the key |
| Offline queue | done | keep | The existing in-memory/serialized queues retry while the page lives; no secret crosses into the worker |

### Media

| Feature | State | Decision | Plan |
|---|---|---|---|
| Adaptive streaming | — | reject | The vault is not a media player |
| Picture-in-Picture | — | reject | No video surface |
| Media Session | — | reject | No media playback |
| Chromecast | — | reject | No cast target |
| Web Codecs | — | reject | AI image/audio generation uses its own bounded codecs; no local transcoding |

### Input

| Feature | State | Decision | Plan |
|---|---|---|---|
| Pointer Events | partial | adopt | Convert remaining touch handlers; keep mouse/touch/stylus unified |
| Gamepad | — | reject | No game controller workflow |
| Web HID | — | reject | Not a PWA capability we can grant safely |
| Web USB | — | reject | Same |
| Serial | — | reject | Same; IWA Direct Sockets can cover future device work |
| Keyboard / `aria-keyshortcuts` | done | keep | Existing keymap and shortcut registry |
| Touch gestures | done | keep | Existing swipe/long-press; audit conflicts with zoom and scrolling |

## Adopted surface

The install/launch surface is complete:

- PNG 192/512, maskable, SVG, `id`, categories, `lang`, `dir`,
  `launch_handler`, `handle_links`, shortcuts and the Apple touch icon.
- File Handling opens the same Import review as the picker. A launch is read
  only after the person opens it; the file is held in memory, never written
  by the handler.
- Share Target accepts one bounded file or text. The service worker stages it
  in a scope-owned cache behind a one-use token and redirects to the app; the
  page removes the token, opens Import review and deletes the staged copy.
- Web Share is an explicit item action and sends the item label only. It never
  sends a password, key, card number, recovery seed or note body.
- Directory export writes an encrypted backup into a directory the person
  chose. Import still goes through the review sheet.
- Wake Lock is acquired only by the visible import/export action and released
  on hide or completion.

## Deliberate non-goals

Payments, digital goods, TWA, media playback/casting, local fonts, gamepads,
HID, USB and Serial stay out of the PWA. IWA Direct Sockets cover future local
device work without weakening the normal web origin.

Window Controls Overlay, URL protocol registration, Idle Detection, Background
Sync, Periodic Background Sync and Background Fetch are rejected for the
reasons in the tables above. No adopted capability remains unimplemented.

## Security rules

- Share target and file handlers open **review**, never a direct merge.
- A shared file or text is hostile input; size, type and content are bounded
  before any parser runs.
- Web Share is explicit and item-scoped; never share a secret because a page
  was opened.
- Content Indexing stays off; vault names and URLs are metadata.
- Wake Lock is visible and time-bounded.
- Protocol handlers must not carry secrets in URLs or fragments.
- The PWA never asks for a powerful permission at boot; the action that needs
  it asks.

## Verification

| Area | Check |
|---|---|
| Installability | Lighthouse installable audit, manifest parse, 192/512/maskable |
| Offline | cold load offline, plan asset cache, stale shell |
| File intake | each handler opens review; malformed input is refused; launch files stay in memory |
| Share target | text/file bounds, one-use token, no automatic write |
| Idle lock | the activity timer locks; activity does not resurrect a locked vault |
| Wake Lock | acquired only on action, released on end/hide |
| IWA | signed bundle, manifest permissions, Direct Sockets refusal outside IWA |
| Touch | 44px target, no hover-only action, pointer/touch parity |
| Accessibility | keyboard path, focus return, contrast, reduced motion |
