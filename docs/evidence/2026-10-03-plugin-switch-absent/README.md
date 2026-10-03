# Plugin tiles draw no switch they cannot act on (ADR 0150, settings rows act or are absent)

Before/after from two real builds of `apps/pages`: the base (`cedad352`, PR
#626's tip) and this branch, walked the same way by
`apps/pages/scripts/capture-evidence.mjs` with [`journey.json`](journey.json).
Counts and sizes are read from the browser by the journey's `count` and
`measure` steps (sizes are `width x height`; `#plugin-surrogate-proxy` and
`#plugin-browser-autofill` are the tiles).

Both builds are stamped as a dedicated deployment
(`PAGES_DEPLOYMENT_PROFILE=dedicated_origin`, `https://vault.example.org`,
`PAGES_HEADER_SECURITY=1`, built with `pnpm --filter @opensesame/pages build`)
so the pairing field is live. The daemon is the stub the journey serves
(`daemonStub`, `apps/pages/scripts/lib/capture-plugin-steps.mjs`); the pairing
code and key are made-up examples. Each walk seals a password vault, turns on
both plugin capabilities, reloads, unlocks, pairs, and opens Settings ›
Capabilities. The desktop walk reaches Settings with `visit` because the
desktop rail has no Settings row to click.

What changed: an uninstalled or forced-off plugin used to draw its switch
disabled, a key that can never act. It is now absent. The tile's mark (`Not
installed`, `Forced off on the daemon`) is unchanged and still says why; the
switch stays, disabled only while a switch is in flight, for a plugin the page
can switch.

Measurements, all from the browser (`switches` = `[aria-pressed]` buttons in the
tile, `disabled` = of those, disabled):

| State | Width | Before | After |
|---|---|---|---|
| Installed, off (control) | 390 | switches 1, disabled 0; keys 44x44, 44x44; tile 358x179 | identical |
| Installed, off (control) | 1280 | switches 1, disabled 0; keys 32x32, 32x32; tile 960x114 | identical |
| Forced off | 390 | switches 1, disabled 1; keys 44x44, 44x44; tile 358x76 | switches 0; key 44x44 (forget); tile 358x62 |
| Forced off | 1280 | switches 1, disabled 1; keys 32x32, 32x32; tile 960x58 | switches 0; key 32x32 (forget); tile 960x58 |
| Not installed | 390 | switches 1, disabled 1; keys 44x44 x3 (switch, forget, copy); tile 358x123 | switches 0; keys 44x44 x2 (forget, copy); tile 358x123 |
| Not installed | 1280 | switches 1, disabled 1; keys 32x32 x3; tile 960x107 | switches 0; keys 32x32 x2; tile 960x107 |

The mark labels `Installed, off`, `Forced off on the daemon` and `Not
installed` each count 1 in both builds, so nothing the tile said was lost.

## Installed, off: the switch stays (control)

![Installed, off, phone](390-installed-off.png)
![Installed, off, desktop](1280-installed-off.png)

## Forced off on the daemon: no switch

![Forced off, phone](390-forced-off.png)
![Forced off, desktop](1280-forced-off.png)

## Not installed: no switch

![Not installed, phone](390-not-installed.png)
![Not installed, desktop](1280-not-installed.png)
