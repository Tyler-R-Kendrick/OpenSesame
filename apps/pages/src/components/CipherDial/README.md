# CipherDial

Decorative lock-v5 astrolabe dial behind the unlock gate: cipher rings, bezel
ornament, index line, and decoded `0PEN SESAME` readout on the column divider.
Ink only; clipped away from the card and release-notes quiet zones.

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
