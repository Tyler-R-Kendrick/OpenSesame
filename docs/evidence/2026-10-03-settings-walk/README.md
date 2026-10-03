# Settings walk: every row acts, or is not drawn (ADR 0158, second pass)

Before/after from two real builds of `apps/pages`: the base (`origin/main`
`1be7b576` merged with `origin/fix-3-connectors` `e115f7b7`, the branch this one
stacks on, so the connector tile fix is in both builds) and this branch, walked the same way by
`apps/pages/scripts/capture-evidence.mjs` with [`journey.json`](journey.json)
and the verbs in `apps/pages/scripts/lib/capture-settings-walk-steps.mjs`.
Every number in a sheet's header is printed by the browser (`count`,
`disabledKeys`, `report`, `sheetText` steps), not read from the diff. Each
screen is captured at 390 × 844 (a coarse touch context) and 1280 × 900.

The walks are a guest on a fresh device (capabilities, keybindings, the
Settings strip, Identity, General) and a sealed personal vault (Security
after a PIN, rotate sheet, Environments, Live sessions, preset, Travel).

| Sheet | 390 | 1280 | What changed |
|---|---|---|---|
| Capabilities, a fresh device | [390](390-capabilities.png) | [1280](1280-capabilities.png) | 17 sections / 37 switches become 15 / 35: Telemetry and Certificate authority had switches over no code |
| Keybindings | [390](390-keybindings.png) | [1280](1280-keybindings.png) | the disabled Reset key is absent until something is changed |
| A macro editor open | [390](390-new-macro.png) | [1280](1280-new-macro.png) | 3 disabled keys become 1 (Save, until named); focus starts in Name |
| Security after a PIN | [390](390-security-after-pin.png) | [1280](1280-security-after-pin.png) | the `.note` box and three captions are gone; the row's mark is the state |
| Rotate the vault key | [390](390-rotate.png) | [1280](1280-rotate.png) | the sheet names what rotation removes (PIN, and the rest of what is enrolled) |
| Environments, none named | [390](390-environments.png) | [1280](1280-environments.png) | no empty select; only the name field and its key |
| Live sessions routes | [390](390-live-routes.png) | [1280](1280-live-routes.png) | Relay only is absent until a TURN server exists |
| Settings strip | [390](390-settings-nav.png) | [1280](1280-settings-nav.png) | 7 tabs become 6: Notifications waits for a service |
| Plugin tiles | [390](390-plugin-tiles.png) | [1280](1280-plugin-tiles.png) | 2 tiles with no field and no key become 0 |
| Identity | [390](390-identity.png) | [1280](1280-identity.png) | 5 switches become 3; the dependents say *needed by*, and every switch that is on looks on |
| Choosing a purpose | [390](390-preset.png) | [1280](1280-preset.png) | the chosen card marks itself at once (0 to 1) |
| Travel, one vault | [390](390-travel.png) | [1280](1280-travel.png) | the Leave key whose sheet refused is absent |
| General | [390](390-general.png) | [1280](1280-general.png) | no sign-out-of-Identity switch for a guest (2 switches become 1) |

## Not here: the connector tiles

Provider tiles that linked to a page nothing routes (Connections off) are fixed by
`fix-3-connectors` (ADR 0151, third amendment) and are in both builds, so this
gallery shows none of that change.

## Not captured

- **Push on this device** (new General row): it needs a configured Identity API
  and a browser with push; neither exists in the static build. It is covered by
  `PushPanel.test.tsx` and `runtime.test.tsx`.
- **The StrictMode authenticator-enrolment fix**: invisible in a production
  build; `verify:auth` drives the whole flow, and `SecondStepCeremonies` has a
  StrictMode regression test.
- Four disabled controls remain on Live sessions: each is a form submit that
  stays disabled until its own field holds a valid value (the documented
  exception in ADR 0158).

## Sheets

### Capabilities, a fresh device

![390](390-capabilities.png)
![1280](1280-capabilities.png)

### Keybindings

![390](390-keybindings.png)
![1280](1280-keybindings.png)

![390](390-new-macro.png)
![1280](1280-new-macro.png)

### Security

![390](390-security-after-pin.png)
![1280](1280-security-after-pin.png)

![390](390-rotate.png)
![1280](1280-rotate.png)

### Environments, Live sessions

![390](390-environments.png)
![1280](1280-environments.png)

![390](390-live-routes.png)
![1280](1280-live-routes.png)

### Settings strip and plugin tiles

![390](390-settings-nav.png)
![1280](1280-settings-nav.png)

![390](390-plugin-tiles.png)
![1280](1280-plugin-tiles.png)

### Identity, purpose, Travel, General

![390](390-identity.png)
![1280](1280-identity.png)

![390](390-preset.png)
![1280](1280-preset.png)

![390](390-travel.png)
![1280](1280-travel.png)

![390](390-general.png)
![1280](1280-general.png)
