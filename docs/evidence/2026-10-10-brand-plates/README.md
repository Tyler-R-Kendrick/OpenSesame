# The brand on plates: one mark, one wordmark, three size tiers

Evidence for the logo component (`apps/pages/src/components/Wordmark.tsx`,
`CipherWordmark/`). Each pair is captured from the base build (`origin/main`)
and from this branch, walked the same way, at phone (390) and desktop (1280)
width, after the decrypt has settled (5.2s). The raw captures stay out of the
repository; the sheets below are the evidence.

| Sheet | What it shows |
|-------|---------------|
| `390-door.png` | The front door's title at 390: the Share Tech Mono slot reel (268×26, eleven LED cells beside an SVG mark) becomes the name punched out of solid ink plates on a canvas, fitted to the card (350×50; em 45, under the 48 the particle field needs), the mark at plate height |
| `1280-door.png` | The same at 1280: the reel at 367×36 becomes the particle field at 480×66 (em 62), ink particles with the letters cut out, frozen once the name has decrypted |
| `390-shell.png` | The shell as a guest at 390: the rail is in the drawer, so the wordmark is not drawn (0×0 before and after); the shot shows the chrome is otherwise unchanged |
| `1280-shell.png` | The rail's wordmark at 12px: 153×15 of slot-reel cells (redacted blocks at that size) becomes the letters tier, 100×19, letters in ink on the plate grid with the same mark the icon draws |

Measurements are the `.door__wordmark`/`.rail__wordmark` canvas (after) or
`.wordmark__slots` (before) bounding boxes the journey printed.

Not captured here, and verified instead:

- Dark theme: the plates read ink from `color` and the slit from `--mark-slit`,
  and repaint on a `data-theme` flip (`use-cipher-lifecycle.ts`); the design
  system's Wordmark preview draws a night panel beside the day one.
- The decrypt itself: `verify:static` samples the real page
  (`scripts/lib/wordmark-contract.mjs`): eleven slots, ten letters with
  210–420ms windows strictly in sequence, exactly one cursor cell at an
  injected clock, the settled plates under reduced motion.
- The unlock card's wordmark replays the decrypt on mount at the card's
  font-size (14–25px: the letters or the solid tier), and the setup bar keeps
  its lettering at 320 (101px wide beside three 44px keys; `verify:mobile`).
- `public/icon.svg` is held to the mark's geometry by `mark-geometry.test.ts`.
