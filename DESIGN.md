---
name: OpenSesame
description: End-to-end encrypted vault for humans, agents, websites, and developers
colors:
  canvas: "#fafafa"
  surface: "#ffffff"
  surface-2: "#f5f5f5"
  surface-3: "#ededed"
  rail: "#fafafa"
  rail-fg: "#171717"
  ink: "#171717"
  ink-2: "#5c5c5c"
  ink-3: "#6f6f6f"
  line: "#e7e7e7"
  line-strong: "#d4d4d4"
  accent: "#0d7268"
  accent-ink: "#ffffff"
  accent-wash: "#eaf2f0"
  ok: "#0f7a51"
  warn: "#a25a05"
  err: "#b32424"
typography:
  display:
    fontFamily: "system mono stack (ui-monospace, SF Mono, Menlo, …)"
    fontSize: "1.4rem"
    fontWeight: 600
    letterSpacing: "-0.021em"
  headline:
    fontFamily: "system mono stack"
    fontSize: "1.0625rem"
    fontWeight: 600
  body:
    fontFamily: "system mono stack for chrome; system-ui for prose"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system mono stack"
    fontSize: "0.75rem"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
rounded:
  md: "2px"
  lg: "2px"
  pill: "999px"
spacing:
  sm: "0.4rem"
  md: "0.9rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.45rem 0.85rem"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  item-row:
    backgroundColor: "transparent"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.6rem"
---

# Design System: OpenSesame

## Overview

**Creative North Star: "One vault, four readings."**

OpenSesame is an end-to-end encrypted vault. A human uses it as a password
manager and passkey store, an agent as a secret store it can never read out, a
website as an auth broker, and a developer as an authority. The same encrypted
store underlies all four, and the interface has to make each one feel like the
product was built for them.

The craft bar is Bitwarden and 1Password. Password-manager canon — unlock gate,
list and detail, conceal by default, copy without revealing — is followed
because users already know it, executed with Scandinavian restraint: a neutral
black-and-white foundation, teal as the single accent, and nothing decorative.

**Key characteristics:**
- Master-password gate, no PIN theater, no recovery path
- One paper surface: the whole workspace is a light, hairline-divided
  terminal — mono filesystem rail, content buffer, statusline. Dark mode
  inverts the same system onto near-black paper.
- Teal is the single accent, and it means state and identity: the cursor,
  the active row, focus, links, and the brand mark. Primary actions are ink.
- Scandinavian restraint: zero-spread neutrals, sentence case everywhere,
  hairline rules and chapters instead of boxed cards, 6/10px radii, no
  decorative gradients or shadows
- List-and-detail spine for the vault; flowing chapter documents for the
  plane-backed sections
- System font stack — no webfont request, no flash, no third-party origin
- Sample data always badged

## Mark

The mark is **the door ajar**: the vault slab slid aside with a slit of
light where it opened — Open Sesame's own story, drawn as two sharp
rectangles. The slab is ink, the light is the accent teal; this is the one
place teal means identity rather than state. In the chrome the mark is
bare — no tile, no circle, no badge — beside the lowercase mono wordmark
`opensesame`. Only the OS app icon puts it on a dark tile with the
platform's mask. The old padlock-in-a-teal-tile is retired everywhere.

## Colors

Neutrals carry the interface. Teal is scarce enough to mean something.

### Primary
- **Accent** (#0d7268): state and identity only — the tree cursor, active
  navigation, focus rings, links, the brand mark, and the strongest step of
  the strength meter. Primary buttons are ink, not accent. In dark mode the
  accent lifts to #2fb3a3.

### Neutral
All neutrals are zero-spread grays — no warm or cool casts anywhere in chrome.
- **Rail** (#fafafa): the navigation plane shares the canvas — one paper
  surface, separated from the buffer by a hairline, not a color change.
- **Canvas** (#fafafa): the ground everything sits on.
- **Surface** (#ffffff): panels and cards.
- **Ink / Ink-2 / Ink-3** (#171717 / #5c5c5c / #6f6f6f): the ink ladder —
  primary, supporting, and metadata text, stepped like alpha-black on white
  (roughly 100% / 64% / 56%). The lowest rung stays above 4.5:1 on white.

### Status
**ok** #0f7a51, **warn** #a25a05, **err** #b32424, each with a wash for filled
callouts. The password strength ramp (`--s-0` … `--s-4`) runs red → amber →
green → teal so "excellent" lands on the brand color.

### Named rules

**The Competitor Marks Rule.** Match Bitwarden's habits, never its brand.

**The Honest Crypto Rule.** Every claim in the interface is one the code makes
true. If copy says nothing leaves the device, nothing leaves the device — the
health report is computed locally and contacts no breach service, and TOTP codes
are derived in the page.

**The No-Recovery Rule.** The absence of a recovery path is stated before the
vault is created, acknowledged with a checkbox, and repeated where it matters.
Never soften it.

## Typography

The chrome speaks mono — the terminal voice. Every control, heading, label,
navigation entry, and data value sets in the system mono stack at 14px.
Prose is the one exception: paragraphs and hints read in the system sans
stack at a readable measure, because explanations are for reading, not
scanning.

### Hierarchy
- Page and detail titles ~1.4rem, weight 600, tight tracking
- Panel headings ~1.0625rem
- Body 15px / 1.5
- Field labels 0.75rem, weight 600, sentence case — never all-caps, never
  tracked out; hierarchy comes from size, ink rung, and space, not from
  shouting. Weights stop at 600.
- Numbers that change in place use `font-variant-numeric: tabular-nums`

## Layout

Desktop is a 15.5rem rail plus content over a full-width statusline — the
terminal frame: tree on the left, buffer in the middle, one mono strip of
plane truth (connectivity, notifications, lock) at the foot. The vault adds
a 21rem list column between rail and detail, giving ranger's three panes;
the other sections read as a single 60rem flowing document of chapters.

Below 900px the rail and statusline give way to a slim top bar (identity,
connectivity, lock) and a five-item tab bar, and the vault collapses to one
pane at a time with a back link. Because the rail carries the vault's
filters, the list header grows a scrolling chip row at that breakpoint —
nothing in the rail may become unreachable.

Prose is measured (roughly 48–62ch). A paragraph is never as wide as a panel.

### VFS interaction model

The workspace is a filesystem, not a webpage. Every vault is a tomb with a
canonical path space — `personal:/Work/GitHub` — folders are directories,
the session context is a shell prompt (`guest@personal:/` — each segment a
button that opens its switcher; never a widget stack of dropdowns),
items are files with kind pseudo-extensions (`GitHub.login`, `Deploy
webhook.secret`), and the vault list renders as a compact first-party mono
file tree (ADR 0066), never as a card wall. The navigation rail is the same
tree one level up: sections are directories off the tomb root (`vault/`,
`connections/`, `access/`, `identity/`, `settings/`), each advertising its
`g`-jump key; the active section is the open directory, with the vault's
filter views, folders, and `health` — and the settings categories — hanging
under it as entries with live counts. A path strip pins the tomb root at the
top of the vault pane; the mobile tab bar keeps labeled icons.

A visible cursor row owns focus — inverse video, always rendered — and
moving it with the keyboard previews that item in the buffer, ranger's own
reading: browsing is previewing. The pane has no header; new and import are
icon keys in the path strip. `j`/`k`/arrows move it, `l`/`→` opens, `h`/`←` collapses or climbs,
`gg`/`G` jump, and `Enter` activates. `/` opens a vim-style command line at
the foot of the pane, backed by a real input so typed keys never leak into
the keymap; matches highlight, non-matches hide, `Esc` closes it. Item verbs
are single keys: `y` copies the secret, `u` the username, `e` edits, `x`
trashes, `n` creates, `.` toggles favorite, and `s` shares a secret once.
`g v/c/a/i/s` jumps between sections and `?` shows the keymap. A mono status
line always shows the focused path, item count, and active filter (or the
live query). Pointer access remains complete: rows click, directories
toggle, a `⋯` menu on the cursor or hovered row carries the verbs, and the
`/` and `?` key chips in the path strip are buttons.

## Elevation & Depth

Hairline borders carry structure; shadows exist only where elevation
communicates behavior (menus, popovers, the unlock card), and even there they
are neutral and barely visible. Panels are bordered, not floated. Rows are
flat with hairline separators.

## Shapes

All-sharp, one documented scale: 2px on every control, chip, badge, and menu
(just enough to keep focus rings clean). Pills survive only where the
mechanic is genuinely round — switch tracks and meter segments. The mark is
bare in the chrome; only the OS app icon keeps a tile and its platform
mask.

## Selection

Selection is inverse video, the terminal's own idiom: the tree cursor, the
rail's current leaf, and pressed toggles render paper-on-ink. Exactly one
row in a tree is inverse at a time — the open directory above a selected
leaf shows only its open caret and weight. Teal never marks selection.

## Components

### Actions are symbols
An action that executes — edit, trash, copy, reveal, rotate, restore, new,
import, save, cancel, lock — renders as an icon key: a square icon button
whose `aria-label` and tooltip carry the sentence. Text survives on a
button only where it is the object of a choice (a provider, a mode, a
navigation target) or where a destructive ceremony must be spelled out.
Never a text verb stretched across a grid row.

### Buttons
Ink fill for the primary action (inverting to paper-on-ink in dark mode),
surface fill with a hairline for secondary, ghost for tertiary, and a
red-tinted variant for anything destructive. One primary per view, sized to
its content — never block-width.

### Forms are records
A form is a record being filled in, not a wall of boxes: each field is a
row — mono label column on the left, value on the right — and inputs are
ruled underlines on the paper (focus thickens the rule to ink). The vault
editor goes further: the item is a file, so its name is the document title,
its kind the extension beside it, and save/cancel are keys in the title
row. Repeatable groups grow with a `+` key beside their label.

### Field rows
The vault's atom: a small sentence-case label, value, and right-aligned
actions. Secrets render as dots with a reveal toggle, and copy never requires
revealing first.

### Navigation
The rail renders as a mono filesystem tree (see "VFS interaction model")
rooted at the prompt line `guest@personal:/`: directory rows with counts
and g-jump key chips. Selection is inverse video (see "Selection"). The
mobile tab bar mirrors the five sections and nothing else.

### Tabs
Flat underline tabs on a hairline: text with a 2px accent underline for the
selected view — never boxed segmented controls.

### Callouts
`note` with `--ok`, `--warn`, `--err` variants for a stated condition. Live
regions are `<output>`, control groups are `<fieldset>`, so the accessibility
role comes from the element rather than an attribute.

### Empty states
An empty state must say what would be here and why it is not — offline,
unauthenticated, or genuinely empty — and offer the action that fills it, as
plain text with no icon tile. The vault's unselected buffer is two mono
lines: what is sealed, and the keys — because moving the cursor previews
items, there is nothing else for it to say. Password-health warnings live in
the global notifications panel so they remain visible from every section.

## Do's and Don'ts

### Do:
- **Do** conceal secret values by default and allow copying without revealing.
- **Do** state what a network-backed surface cannot show while offline or
  unauthenticated.
- **Do** badge sample data on every item and keep removing it to one action.
- **Do** treat a reload re-locking the vault as correct behavior and say so.

### Don't:
- **Don't** add a shortcut around the master password. A passkey or PIN may
  unlock the vault, but each is an alternate wrap of the same vault key,
  entered every time — never a remembered device and never a recovery path.
- **Don't** put a secret, or a hash of one, on the network.
- **Don't** let prose run the full width of a panel.
- **Don't** clone Bitwarden's brand identity.
