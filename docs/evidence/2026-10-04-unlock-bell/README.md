# The unlock screen has a bell now — 2026-10-04

Before/after for [ADR 0163](../../adr/0163-failures-live-in-the-tray.md): a
failure is a notice in the tray, not a box in the page. The screens before
unlock have no shell and so no bell, which is why `NoticeCorner` exists. This
is the picture that was owed on #662. Two real builds (base `107ec5e`, which is
`main`, and this branch), the same walk by `journey.json`:
seal a password vault, lock it, type a wrong password, press **Unlock**, then
open the bell. Desktop 1280 × 800 with a mouse, phone 390 × 844 with touch.

| Sheet | Shows | Measured in the browser |
| --- | --- | --- |
| `1280-unlock-error.png` | The unlock card after a wrong password, desktop | before: `.note--err` 432×44 in the card, no corner bell; after: none, corner row 1280×47 at 0,0 holding the bell |
| `1280-unlock-tray.png` | The bell opened | before: no bell on the screen; after: the tray holds the sentence |
| `390-unlock-error.png` | The same, phone | before: `.note--err` 324×44; after: none, corner row 390×52 at 0,0 holding a 44×44 bell |
| `390-unlock-tray.png` | The bell opened, phone | before: no bell; after: the tray holds the sentence |

The numbers are the `measure` and `report` steps in `journey.json`, printed by
the capture run.

The corner bell is a row in the page flow above the screen, not a fixed
overlay, so it can never rest on a control or on the release-notes chevron (an
earlier cut floated it over the viewport and sat close to the chevron). The
screen is pushed down by the row's height while the tray holds something, and
the row draws only then.
