# Toasts for notices — before and after

Two real builds, the same steps: `main` (`fb491073`) and this branch.

**Steps, both builds:** open a claim link cold (`/claim#token=…`, a well-formed
but unknown bearer), wait for the page to settle, press **Continue as guest**
while no sign-in service is reachable, then wait 1.2 s and capture. The claim
fails and the failure is a tray notice in both builds. This branch also shows
it as a toast.

Measurements are read from the browser (`getBoundingClientRect`, and the bell's
accessible name), not from the CSS. Source: `before.json` and `after.json`.

## 390 × 844 (phone)

| | before (`main`) | after (this branch) |
|---|---|---|
| Toast | none | 352 × 129 px at (22, 60), text “Claim — Could not start a guest session. Try again.” |
| Bell | “Notifications — 1 pending” | “Notifications — 1 pending” |

1. [`before-390.png`](before-390.png)
2. [`after-390.png`](after-390.png)

## 1280 × 800 (desktop)

| | before (`main`) | after (this branch) |
|---|---|---|
| Toast | none | 352 × 109 px at (912, 55), same words |
| Bell | “Notifications — 1 pending” | “Notifications — 1 pending” |

1. [`before-1280.png`](before-1280.png)
2. [`after-1280.png`](after-1280.png)

## What these images do not show

- **The system notification.** It needs the browser's notification permission
  and a hidden tab, so it is not in these captures. It is covered by
  `ToastStack.test.tsx` and `watch.test.ts`.
- **Toast timing.** The toast goes after about 6 s unless the pointer or focus
  is on it. The captures are taken at 1.2 s.
- **The capture harness.** `capture-evidence.mjs` prepares the screen before its
  steps run, which put this page in the unlocked shell, so the claim screen
  never rendered through it. These pairs were captured with a small probe
  against the same two builds instead.
