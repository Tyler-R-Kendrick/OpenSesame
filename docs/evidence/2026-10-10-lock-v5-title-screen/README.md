# Lock v5 title screen evidence (2026-10-10)

## Reference provenance

| Source | Result |
|--------|--------|
| `lock-v5.html` on `main` | **Not in git** (code search: comments only) |
| `origin/cursor/lock-v5-unlock-b359` (#947) | **`apps/pages/src/dev/LockV5Demo.tsx`** + `lock-v5-demo.css`; dev route `/dev/lock-v5` |
| `origin/claude/design-system-extraction-vvifv5` (#1012) | No lock-v5 HTML or demo |
| `docs/` | No lock-v5 artifact |
| `LockV5UnlockReference.tsx` (prior harness) | **Withdrawn** — not an authoritative reference |

The dial/doors geometry reference is the **LockV5Demo stage** (wide two-column card + notes shell), not a self-authored unlock harness.

## Captures

- `reference-stage-{390,1024,1280}.png` — LockV5Demo stage (requires dev server + `LOCK_V5_DEV_ORIGIN`)
- `unlock-{390,1024,1280}-settled.png` — locked gate, dial settled
- `unlock-{390,1024,1280}-doors.png` — mid-doors after PIN unlock

Capture:

```bash
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
pnpm --filter @opensesame/pages dev:web   # :5180
LOCK_V5_DEV_ORIGIN=http://localhost:5180/OpenSesame \
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-lock-v5-evidence.mjs
```

## Layout intent (from LockV5Demo + `apply-dial-layout.ts`)

- **Wide (≥1100px):** rings meet the notes column divider; index overlay may straddle the seam; ring layer clipped at `notes.x`.
- **Narrow:** corner dial in the band below the card; notes accordion collapsed; overlay masked out of the notes rect (no letter ink on release notes).
- **Doors:** card and notes translate per `vault-doors.css`; hero wordmark moves with the card; no hero cipher replay on unlock (keeps full wordmark during doors).
