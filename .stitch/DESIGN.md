# Design System: OpenSesame
**Project ID:** (create the Stitch project, then paste its `projects/<id>` here — docs/design/tooling.md § Stitch)

## 1. Visual Theme & Atmosphere
A vault, not a dashboard: quiet, dense where it works and empty where it rests,
drawn entirely in ink and paper. Nothing is coloured. Status, identity and
emphasis are carried by shade, shape, texture and motion — a hatched square
means busy, an inverted square means armed, particles settling into plates
mean the name has been decrypted. The mood is utilitarian and exact: square
corners everywhere, hairline rules, monospace labels in the margins, and a
single accent that is simply the ink itself. Day is paper-white; Night is
near-black with the same relationships inverted. Textures (hatching, dot
grids, particle fields) are welcome; hue is not.

## 2. Color Palette & Roles
Day (default):
- **Paper (#fafafa)** — the canvas every screen sits on.
- **Surface White (#ffffff)** — cards, sheets, the editor stage.
- **Surface Fog (#f0f0f0)** — a second surface: list hover, the keymap sheet's rows.
- **Surface Ash (#e2e2e2)** — a third surface: pressed states, the armed key's twin.
- **Ink (#171717)** — text, the accent, every control's face, the ok and err glyphs. The accent IS the ink.
- **Ink Soft (#4d4d4d)** — secondary text, the margin voice beside a commit square.
- **Ink Muted (#666666)** — tertiary text, placeholders, the rail's quiet labels.
- **Hairline (#e0e0e0)** — every rule and border.
- **Hairline Strong (#bdbdbd)** — a focused field's edge, the accent line under a selected tab.
- **Warn Slate (#5c5c5c)** — the warn glyph's ink; a warning is a darker grey, never amber.
- **Err Wash (#d9d9d9)** — the wash behind an error mark; the error's ink stays Ink.
- **Accent Ink on Accent (#fafafa)** — text on an inverted (armed, selected) control.
- **Slit Grey (#8f8f8f)** — the slit of light in the mark, the one grey in the logo.
- **Scrim (rgba(0,0,0,0.44))** — behind a sheet.

Night: Paper becomes **Night (#0f0f0f)**, Ink becomes **Chalk (#f5f5f5)**, and
every surface and hairline steps the same distance from the new canvas. No
colour is introduced in either mode. The only hue in the product is the
identicon glyph, derived from an identity, never from a state.

## 3. Typography Rules
Two voices. The reading voice is the system sans (`system-ui`), 14–16px,
normal weight, line-height 1.5, used for every value, every row and every
heading; headings are the same face a step larger, never bold-display. The
margin voice is monospace (`ui-monospace`), 11–12px, uppercase-free, slightly
letter-spaced (0.02em), used for labels above values, the crumbs, keyboard
hints, status words and the verb beside a commit square. The brand line is
not a font at all: "OPEN SESAME" is punched out of plates on a canvas in three
size tiers (letters under 16px, solid plates to 48px, a particle field above).
No italics, no condensed display faces, no serif.

## 4. Component Stylings
* **Buttons:** There are no word buttons. An action is an **icon key**: a 44px
  square (36px small) with a 20px glyph, ink on paper, a hairline border on
  hover, inverted (paper on ink) when armed or selected; its sentence is the
  accessible name and tooltip, never painted on the face. The one key that
  ends a form is the **go square**, the same 44px square with a check glyph
  and its verb written beside it in the margin voice. Nothing is red: the
  destructive key is the ordinary square with a bin glyph, armed by one press,
  fired by the next. Corners are sharp, squared-off edges (radius 0).
* **Cards/Containers:** Flat. A sheet is a white surface on the scrim with a
  hairline edge and no shadow; a panel is separated by rules and whitespace,
  not elevation. Square corners, always. Depth is told by shade (paper → fog →
  ash), never by blur.
* **Inputs/Forms:** A field is a label in the margin voice above a value on
  the surface, with a hairline underneath that strengthens on focus
  (#bdbdbd) and a 2px ink focus ring. 16px text on a phone so iOS never zooms.
  An invalid field keeps its ink and gets a status mark and a notice in the
  tray; no red box, no inline error paragraph.
* **Status:** A 14px glyph in a square — check (ok), triangle (warn, in Warn
  Slate), cross (err, on the err wash), lock (idle) — with its words as the
  tooltip. Never a coloured pill, never a dot.
* **Lists:** 44px rows, hairline separators, the selected row on Surface Fog
  with a 2px ink bar at its left edge. Identicons (3px dot glyphs) lead a row
  where identity matters.

## 5. Layout Principles
A two-tree shell: a 220px rail of sections on the left, the listing and its
record on the right, a one-row statusline (command bar, pending keys, bell)
along the bottom. On a phone the rail becomes a drawer and the statusline a
44px toolbar; every control stays 44px and nothing floating rests on one.
Spacing runs on a 4px grid (4, 8, 12, 16, 24, 32); gutters are 16px on a
phone and 24px on a desktop; the record stage is capped at 720px of reading
width. Whitespace does the grouping — rules are hairlines and few. Gates (the
front door, unlock, setup) are a single centred card on the paper with the
brand line at hero size and at most two roads; a help key sits in the chrome
corner and never in front of the content. Motion is brief and mechanical:
120–200ms eases, the particle decrypt once per session, and everything honours
reduced motion.
