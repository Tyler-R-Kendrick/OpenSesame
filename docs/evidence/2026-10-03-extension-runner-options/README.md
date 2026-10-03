# Extension local runner: the options page

The browser extension gains an options page (`apps/browser-extension/entrypoints/options/`)
where a person sets up the local runner: Host session, recovery key, a credential and an
optional login check for an origin, the one site to drive, and held candidates.

This is a **new screen**, so there is no base-branch build to pair it with: the base
extension has no options page. What is shown is this branch's build (`pnpm --filter
@opensesame/browser-extension build`, served over loopback with the `browser` API stubbed
to a fixed runner status), at desktop and phone width, in the two states that matter.

| State | Width | Image | Page height | Horizontal overflow | Smallest control |
|---|---|---|---|---|---|
| empty | 1280px | `options-empty-desktop.png` | 1570px | 0px | 33px |
| empty | 390px | `options-empty-phone.png` | 1570px | 0px | 33px |
| ready | 1280px | `options-ready-desktop.png` | 1762px | 0px | 33px |
| ready | 390px | `options-ready-phone.png` | 1762px | 0px | 33px |

- **empty** is a bare install: none of the four readiness rows is checked except the private-window one.
- **ready** has a Host session, a pinned recovery key, one credential held, one site armed, one candidate held and a last pass of one run driven and six steps settled.
- Measurements come from the browser (`scrollWidth - clientWidth`, `getBoundingClientRect().height` of every button, input, select and textarea), not from the CSS; `measurements.json` has the raw rows.
- No page error and no failed request except the browser's automatic favicon fetch.

Two defects the first capture showed are fixed in this build: the readiness rows right-aligned their text, and the one-time private-key field showed before a key was created because `.field { display: grid }` overrode `hidden`.

The popup is unchanged.
