# The unlock screen has a bell now — 2026-10-04

Before/after for [ADR 0161](../../adr/0161-failures-live-in-the-tray.md): a
failure is a notice in the tray, not a box in the page. The screens before
unlock have no shell and so no bell, which is why `NoticeCorner` exists. This
is the picture that was owed on #662. Two real builds (base `6749fd2`, which is
`main` as of the last merge, and this branch), the same walk by `journey.json`:
seal a password vault, lock it, type a wrong password, press **Unlock**, then
open the bell. Desktop 1280 × 800 with a mouse, phone 390 × 844 with touch.

| Sheet | Shows | Measured in the browser |
| --- | --- | --- |
| `1280-unlock-error.png` | The unlock card after a wrong password, desktop | before: `.note--err` 432×44 in the card, no corner bell; after: none, corner bell 35×39 at 1237,8 |
| `1280-unlock-tray.png` | The bell opened | before: no bell on the screen; after: the tray holds the sentence |
| `390-unlock-error.png` | The same, phone | before: `.note--err` 324×44; after: none, corner bell 44×44 at 338,8 |
| `390-unlock-tray.png` | The bell opened, phone | before: no bell; after: the tray holds the sentence |

The numbers are the `measure` and `report` steps in `journey.json`, printed by
the capture run.

On desktop the corner bell sits near the top edge of the release-notes panel's
header; it does not cover its chevron (about 23px apart in the sheet). It is
fixed to the viewport and appears only while the tray holds something.
