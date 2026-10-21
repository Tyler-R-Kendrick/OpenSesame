# CipherDial

Animated astrolabe behind the unlock gate. On wide screens its center meets
mid-height of the column divider and its outer bezel leaves space above and
below. The right semicircle clips at the opaque notes pane. Narrow layouts
keep the corner arc in the empty band. The enclosing bezel is smooth hairline
circles and fine ticks; there are no perimeter teeth or compass numbers.

The rings remain faint and visible: their layer opacity is 18% in dark
themes and 50% in light themes. Under the credential card they fade
to 30% of that already quiet layer over a feathered 56px band (`mask.ts`).
Idle counter-rotation continues; only the successful alignment lights the
index and decoded `0PEN SESAME` readout before the doors open. Reduced-motion
preference keeps a static cipher.

Ported from `lock-v5-handoff` (`v-lock-v5.js` cipher rings + `drawFixed`).

## Props

| Prop | Role |
|------|------|
| `paneRef` | Unlock column pane (position + size for layout) |
| `cardRef` | Credential card element (quiet mask) |
| `notesRef` | Release-notes column (quiet mask, wide layout) |
| `phase` | `idle` \| `align` \| `open` — ceremony phase from `UnlockLockV5` |
| `alignStartMs` | `performance.now()` when align began; `null` when idle |
| `lit` | Index-line brightness during align (0–1) |
| `reducedMotion` | Override `prefers-reduced-motion` |
| `onSplitX` | Reports divider X in pane coordinates for `VaultDoors` |

## Usage

```tsx
import { useRef, useState } from "react";
import { CipherDial } from "./components/CipherDial/index.js";

const paneRef = useRef<HTMLDivElement>(null);
const cardRef = useRef<HTMLDivElement>(null);
const notesRef = useRef<HTMLElement>(null);
const [splitX, setSplitX] = useState(0);

<CipherDial
  paneRef={paneRef}
  cardRef={cardRef}
  notesRef={notesRef}
  phase="idle"
  alignStartMs={null}
  lit={0}
  onSplitX={setSplitX}
/>;
```

## Dev gallery

Local Vite only: `http://localhost:5180/OpenSesame/dev/lock-v5`
(`LockV5Demo.tsx`).
