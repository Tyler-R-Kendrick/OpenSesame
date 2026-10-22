# PWA capability review

Reviewed: 2026-10-22. Sources:

- [Powerful PWAs](https://chromeos.dev/en/web/powerful-pwas)
- [Desktop Progressive Web Apps](https://chromeos.dev/en/web/desktop-progressive-web-apps)
- [PWA checklist](https://web.dev/pwa-checklist/)
- [Web Capabilities tracker](https://goo.gle/fugu-api-tracker)

Status in those pages changes. This document records what OpenSesame has,
what it should adopt, and what it should deliberately refuse. It is a plan,
not a claim that every line is implemented.

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
| Web Share | — | planned | Explicit Share action for non-secret text/item labels; never auto-share values |
| Web Share Target | — | planned | `POST /share-target` into the import review sheet, not a direct vault write |
| URL protocol registration | — | defer | A `web+opensesame` handler could help deep links, but needs an anti-hijack review |
| `launchQueue` | — | planned | Needed for file handlers and protocol launches |
| Local Peer-to-Peer | adapter | pilot | Nearby Live sharing after the draft ships; WebRTC stays default |
| File Handling API | — | planned | Open `.kdbx`, `.1pux`, `.json`, `.env`, `.csv` into Import review |
| File System Access | done | keep | Save/open pickers and OPFS attachment storage |
| Directory read/write | partial | planned | Directory export/import for encrypted backups, review-first |

### Window management

| Feature | State | Decision | Plan |
|---|---|---|---|
| Fullscreen | — | defer | No media or presentation surface needs it |
| Cross-Screen Window Placement | — | reject | No multi-display canvas/window workflow |
| Tabbed Application Display Mode | — | defer | Revisit if the rail becomes true multi-document tabs |
| Window Controls Overlay | — | planned | Only after the titlebar and `env(titlebar-area-*)` layout exist |

### Deeper OS integration

| Feature | State | Decision | Plan |
|---|---|---|---|
| Local Fonts | — | reject | Fingerprinting and no product need; the app ships its own type stack |
| Wake Lock | — | planned | Hold only during a visible long import/export; release on hide/end |
| Idle Detection | — | planned | Opt-in auto-lock after inactivity; never a background surveillance signal |
| Badging | done | keep | Existing |
| App icon shortcuts | done | keep | Existing |

### Offline and background

| Feature | State | Decision | Plan |
|---|---|---|---|
| Background Sync | — | planned | Queue ciphertext-only tailnet/relay work; retry on reconnect |
| Periodic Background Sync | — | defer | Browser support and value are limited; no secret work in a periodic wake |
| Content Indexing | — | reject | Item names, URLs and counts are vault metadata; do not surface them in the OS |
| Background Fetch | — | planned | Large attachment upload/download where the service worker can keep progress |
| Offline queue | partial | keep | Existing in-memory/serialized queues; add durable service-worker retry only where safe |

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

## Phased plan

### Phase 0 — manifest and install hygiene (now)

- Done: PNG 192/512, maskable, SVG, `id`, `categories`, `lang`, `dir`,
  `launch_handler`, `handle_links`, shortcuts, Apple touch icon.
- Add screenshots once stable captures exist; do not add fake screenshots.
- Keep the PWA and IWA manifests generated from one source of truth.

### Phase 1 — launch and file intake

1. Add a shared launch-queue reader that consumes `LaunchParams` once and
   routes to Import, not directly to a vault write.
2. Add manifest `file_handlers` for `.kdbx`, `.1pux`, `.json`, `.env`, `.csv`
   and the interoperable formats the import bundle already accepts.
3. Add `share_target` `POST` handling through the existing import review sheet;
   text and files are untrusted input.
4. Add an explicit Web Share action for non-secret metadata and a separate
   confirmation for any secret value.
5. Add `web+opensesame` only after an origin/URL anti-hijack review.

### Phase 2 — OS behaviour

1. Add opt-in idle-based auto-lock, with the same lock path as the existing
   timer; no idle data leaves the page.
2. Add Wake Lock during a visible long-running export/import only.
3. Add Window Controls Overlay only with a titlebar layout and safe area tests.
4. Add tabbed display only if multi-document navigation is real, not a visual
   imitation.

### Phase 3 — offline reliability

1. Move safe tailnet/relay retry work into Background Sync with ciphertext-only
   payloads.
2. Evaluate Periodic Background Sync for rotation queue wakeups; refuse if the
   browser cannot run it reliably or if it would expose metadata.
3. Add Background Fetch for large attachment transfer with visible progress.
4. Keep Content Indexing disabled: the OS index would reveal vault metadata.

### Phase 4 — deliberate non-goals

Payments, digital goods, TWA, media playback/casting, local fonts, gamepads,
HID, USB and Serial stay out of the PWA. IWA Direct Sockets can cover future
local device work without weakening the normal web origin.

## Security rules

- Share target and file handlers open **review**, never a direct merge.
- A shared file or text is hostile input; size, type and content are bounded
  before any parser runs.
- Web Share is explicit and item-scoped; never share a secret because a page
  was opened.
- Content Indexing stays off; vault names and URLs are metadata.
- Idle Detection is opt-in and used only to lock, not to profile.
- Wake Lock is visible and time-bounded.
- Background Sync carries ciphertext or opaque IDs, never a decrypted value.
- Protocol handlers must not carry secrets in URLs or fragments.
- The PWA never asks for a powerful permission at boot; the action that needs
  it asks.

## Verification

| Area | Check |
|---|---|
| Installability | Lighthouse installable audit, manifest parse, 192/512/maskable |
| Offline | cold load offline, plan asset cache, stale shell |
| File intake | each handler opens review; malformed input is refused |
| Share target | text/file bounds, CSRF/origin, no automatic write |
| Background sync | ciphertext only, retry after reconnect, no duplicate writes |
| Idle lock | inactivity locks, activity does not resurrect a locked vault |
| Wake Lock | acquired only on action, released on end/hide |
| IWA | signed bundle, manifest permissions, Direct Sockets refusal outside IWA |
| Touch | 44px target, no hover-only action, pointer/touch parity |
| Accessibility | keyboard path, focus return, contrast, reduced motion |
