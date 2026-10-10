# CipherWordmark

Lock-v5 particle-plate wordmark ported from `lock-v5-handoff` (ThreeUI-style
field on punched plates, Geist Mono ExtraBold subset in `fonts/os-logo.ttf`).

## Visual vs accessible name

- Canvas line defaults to **`0PEN SESAME`** (`DISPLAY_WORD`).
- Product chrome wraps this as **`open-sesame`** in a visually hidden span for
  tests and assistive technology (`Wordmark.tsx`).

## Decrypt cursor (amendment)

The active cell is **not** a hairline border. The whole plate brightens and
densifies (higher particle alpha) while the reel steps L→R; the punched glyph
stays visible through the mask. When a slot settles, the cursor moves on; when
all slots finish, the cursor is gone.

## Small sizes

When cap height falls below ~14px (`SMALL_GLYPH_PX`), the canvas switches to
solid ink plates with punched letter cutouts (no particle field) so cells stay
legible in the rail and setup bar.

## Props

| Prop | Role |
|------|------|
| `text` | Plate letters (default `0PEN SESAME`) |
| `size` | Optional em px override; else uses computed `font-size` |
| `animateOnMount` | Start decrypt on mount |
| `replay` | Start a fresh decrypt on mount |
| `showCursor` | Brightness cursor on the active cell (whole-plate alpha boost — never a stroked frame). Light ink (dark theme) uses a slightly stronger boost so the plate still reads at 1× / DPR 3. Settled decrypt clears the cursor. Small solid plates use the same active/rest alpha pair when an animation is shown. |
| `theme` | `default` \| `rail` |
| `reducedMotion` | Override system reduced-motion |
| `static` | Settled field, no animation |
| `onSettled` | Fires once when decrypt completes |
| `includeMark` | Draw ink slit mark inside canvas (demos) |
| `ref.replay()` | Imperative replay |

`data-cipher-timings` on the root holds JSON slot delays for static verify.

## Fallback

If `canvas` or `getContext` is missing, the component renders an empty canvas
frame; `Wordmark` still exposes the hidden accessible name.

## Favicon

Site icons under `apps/pages/public/` (`icon.svg`, manifest references) are
generated from the static slit mark (`includeMark` / `drawIconMark` geometry),
not from a decrypt frame:

```bash
node apps/pages/scripts/generate-cipher-icons.mjs
```

## Dev gallery

In local Vite only, the lock-v5 component gallery lives at
`http://localhost:5180/OpenSesame/dev/lock-v5` (see `apps/pages/src/dev/LockV5Demo.tsx` on
the unlock branch).

## Usage

```tsx
import { CipherWordmark } from "./components/CipherWordmark/index.js";

<CipherWordmark animateOnMount replay={false} showCursor />
<CipherWordmark static includeMark size={12} theme="rail" />
```
