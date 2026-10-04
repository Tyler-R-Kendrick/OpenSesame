# Failures live in the tray — 2026-10-04

Before/after for [ADR 0161](../../adr/0161-failures-live-in-the-tray.md): a
failure is a notice in the tray, never a red box in the page. Captured from two
real builds (base `c5c9ab6` and this branch), walked the same way by
`journey.json`: a guest opens **New item**, clears the name, and presses **Save
item**; then the bell is opened. Desktop 1280 × 800 with a mouse, phone 390 × 844
with touch.

| Sheet | Shows | Measured in the browser |
| --- | --- | --- |
| `1280-error.png` | The editor after the failed save, desktop | before: `.note--err` 640×44 in the editor; after: none |
| `1280-tray.png` | The bell opened | before: "Nothing waiting"; after: a card holding the sentence |
| `390-error.png` | The editor after the failed save, phone | before: `.note--err` 358×44 in the editor; after: none |
| `390-tray.png` | Notifications opened from the More sheet | before: "Nothing waiting"; after: a card holding the sentence |

The measurements are the `measure` and `report` steps in `journey.json`,
printed by the capture run.

Not shown here: the shell-less screens (unlock, front door, federated return,
unframed popup) that now get the corner bell. They are covered by
`verify:auth` (a wrong recovery key and a wrong code are read from the corner
bell, and focus is checked on return) and `NoticeCorner.test.tsx`, not by a
picture.
