# The Add button: a sharp square, held and slid

The phone's Add button lost its ellipsis and its bottom sheet. It is one sharp
56 × 56 square with a plus. Holding it draws a drag area around it: slide up to
**Import**, slide down to **Export**, and let go on the zone. Letting go
anywhere else chooses nothing.

Before is the commit before this change; after is this branch. Both are real
builds, walked the same way as a guest on the list, with a real touch (raw
touch events through the browser's input pipeline). The journey is
[`journey.json`](journey.json). Measurements are read from the browser.

| screen | before → after |
|---|---|
| Add button at rest, 390 | `fab 100x56, radius 28px (56 + 44px ellipsis, two targets) → fab 56x56, radius 0px, one target` |
| Add button at rest, 320 | `fab 100x56, radius 28px → fab 56x56, radius 0px` |
| Hold, 390 | `Add actions sheet from the bottom edge → .add-slide__zone 56x44 ×2 (labels 127x44), radius 0px, both in the viewport` |
| Hold, 320 | `Add actions sheet → .add-slide__zone 56x44 ×2, both in the viewport` |

## At rest, 390 × 844

![The Add button at rest, 390](390-add-at-rest.png)

## Held, 390 × 844

![Holding the Add button, 390](390-add-held.png)

## Slid up (Import), 390 × 844

![Sliding up to Import, 390](390-add-slid-up.png)

## Slid down (Export), 390 × 844

![Sliding down to Export, 390](390-add-slid-down.png)

## At rest, 320 × 568

![The Add button at rest, 320](320-add-at-rest.png)

## Held, 320 × 568

![Holding the Add button, 320](320-add-held.png)

## Slid down (Export), 320 × 568

![Sliding down to Export, 320](320-add-slid-down.png)

## Not captured

Desktop width: the Add button is the phone's, and a wide window draws the
command row's icon keys, which this change does not touch. The old build's slid
shots repeat its sheet, because a slide did nothing there.
