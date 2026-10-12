# VaultDoors

Split-door transition at the unlock column divider (wide) or viewport center
(narrow). Hairline seams ride the moving edge. With `prefers-reduced-motion`,
a short crossfade replaces the slide.

Wired from `UnlockLockV5` after a successful unlock; `unlockCeremonyStore`
holds the gate until the animation finishes.

## Props

| Prop | Role |
|------|------|
| `active` | Doors visible and animating |
| `openStartMs` | `performance.now()` when open slide began; `null` until started |
| `splitX` | Divider X from `CipherDial` `onSplitX` |
| `paneRef` | Unlock pane (applies `--unlock-door-*` on `.unlock` ancestor) |
| `reducedMotion` | Override `prefers-reduced-motion` |
| `onComplete` | Fires once when the door motion finishes |

## Usage

```tsx
import { VaultDoors } from "./components/VaultDoors/index.js";

<VaultDoors
  active={doorsActive}
  openStartMs={openStartMs}
  splitX={splitX}
  paneRef={paneRef}
  onComplete={() => unlockCeremonyStore.end()}
/>;
```

## Dev gallery

Local Vite only: `http://localhost:5180/OpenSesame/dev/lock-v5`
(`LockV5Demo.tsx`).
