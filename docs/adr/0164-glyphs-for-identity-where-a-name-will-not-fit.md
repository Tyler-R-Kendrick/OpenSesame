# ADR 0164 — Glyphs: a dotted mark for identity where a name will not fit

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR 0089](0089-device-vault-switching.md) (one list of the
  vaults on a device; a project's name is sealed until unlock),
  [ADR 0139](0139-one-definition-every-target.md) (a behaviour's test vectors
  are written once under `spec/`),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing is stored in the
  clear; a glyph stores nothing),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md) (nothing is removed to
  make room)

## Context

The session prompt reads `who@vault:/`. On a phone that is two names in a top
bar that also carries the drawer, the lock and three more keys, so each is
ellipsised to a few characters and two vaults called `project · 4f2a` and
`project · 9c11` look alike at a glance. The names are long because they are
the only identity the product draws. A person with several vaults and a few
organizations needs a mark they can recognise faster than they can read.

## Decision

1. **A glyph is a seeded, symmetric dot pattern.** It is drawn the way GitHub
   draws an identicon — a hash folded into a left-right mirrored grid — out of
   braille dots: 8 × 8 dots, four braille cells by two, 32 free bits plus one
   of 24 hues. The same pattern is a string of braille characters in a terminal
   and an SVG of the same dots in the shell, so a glyph looks the same in a CLI
   and on a phone. `packages/app-core/src/lib/glyph.ts` is the one
   implementation; `spec/conformance/glyph-vectors.json` pins its output.
2. **A glyph is an address, not a secret and not a name.** Its seed is an id
   the device already shows in the clear — a tomb id, the federated subject
   (per-origin and stable) or, for a guest, the Identity principal id, an
   organization id — domain-separated by kind and versioned
   (`opensesame:glyph:v1:<kind>:<id>`). Never a name or an address (they
   change, and a face must stay one thing's), and never a sealed vault name, so
   a glyph may stand for a vault before unlock. It is display only: never a
   check that two things are the same, never an input to authorization.
3. **The phone's top bar draws the glyph where the desktop prompt draws the
   name.** The name stays in the DOM and in `aria-label`, so what a control is
   called does not change with the width it is drawn at. The glyph is
   decorative (`aria-hidden`).
4. **Nothing is removed.** Pressing a glyph opens the same switcher, which
   names every vault or profile beside its own glyph, marks the open one, and
   lets a person pick another. Holding a finger on it does the same — the
   platform's own long-press `contextmenu` is answered with the switcher
   instead of the session menu, which a phone reaches through the drawer — and
   the lift that ends the hold does not close it again. A mouse's right-click
   keeps the session menu. The vault list (front door, `@tomb` prompt, Manage)
   draws each vault's glyph in the slot its kind icon held, so a face is always
   introduced beside the name it stands for.
5. **The switchers must be reachable on a phone.** The top bar's prompt
   clipped the menus it hangs below itself (`overflow: hidden`) and the vault
   list ran wider than the screen, so on the base build pressing a segment drew
   nothing. With a glyph standing for the name, the menu is the only place a
   name is read, so the top bar's menus now take the width of the screen under
   the bar.
6. **A change to the algorithm is a change to every glyph a person has
   learned.** The seed carries `v1`; replacing a step means a new version and
   new vectors, never an edit.

## Consequences

- The top bar spends a glyph's width (28 px) per segment instead of an
  ellipsised name, and drops the `:/` that only finished the prompt.
- Two vaults can in principle share a glyph (a 2^32 · 24 space); the name in
  the menu is always the authority, and the glyph never decides anything.
- Colour is a second cue, never the only one: the pattern carries identity and
  the lightness is set per theme for contrast.
- The terminal form (`glyphText`, `glyphAnsi`) is available to the CLIs; no
  verb prints it yet.
