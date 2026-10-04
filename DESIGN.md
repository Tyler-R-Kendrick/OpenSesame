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
  scrim: "rgba(0, 0, 0, 0.44)"
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
  chrome:
    fontFamily: "system mono stack"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "system-ui"
    fontSize: "0.9375rem"
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

## Mark

The mark is **the door ajar**: the vault slab slid aside with a slit of
light where it opened — Open Sesame's own story, drawn as two sharp
rectangles. The slab is ink, the light is the accent teal; this is the one
place teal means identity rather than state. In the chrome the mark is
bare — no tile, no circle, no badge — beside the lowercase mono wordmark
`open-sesame`. Only the OS app icon puts it on a dark tile with the
platform's mask. The old padlock-in-a-teal-tile is retired everywhere.

The wordmark reveals through eleven character-sized background slots. Each slot
steps through hexadecimal ciphertext and locks to its letter before the next
begins: randomly 6–12 glyph cycles at 35ms each, once on entry, without delaying
interaction. Counts stay fixed through re-renders; the full reveal takes 2.31–4.62s.
The reels are decorative; assistive technology reads `open-sesame` once.
Reduced motion shows the completed word immediately. All front doors and the
desktop rail use the same `Wordmark` component, and the reel runs once per
session: the gate a person arrives on owns the moment, and every wordmark
mounted after it — the setup ceremony, the rail — stands still on its letters.

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
- The front door's title is the wordmark at display scale —
  `clamp(1.75rem, 8vw, 2.6rem)`, the one display step, used nowhere else
- Page and detail titles ~1.4rem, weight 600, tight tracking
- Panel headings ~1.0625rem
- Body 15px / 1.5
- Field labels 0.75rem, weight 600, sentence case — never all-caps, never
  tracked out; hierarchy comes from size, ink rung, and space, not from
  shouting. Weights stop at 600.
- Numbers that change in place use `font-variant-numeric: tabular-nums`

## Layout

Desktop is a 15.5rem rail plus content over a full-width statusline — the
terminal frame: tree on the left, buffer in the middle, one mono strip
(support, the command, notifications) at the foot. The strip is
keys only. The command bar under the crumbs is the chrome's one typed field:
a command runs, and a sentence it cannot parse goes to Support as a question,
so nothing else in the frame asks to be typed into. The vault adds
a 21rem list column between rail and detail, giving ranger's three panes;
the other sections read as a single 60rem flowing document of chapters.

Below 900px the rail gives way to a slim top bar (the account and the lock),
the statusline keeps the command, a section drawer key closes the
frame, and the vault collapses to one pane at a time, each with a back key and
a back swipe: the **section tree** (the rail's own `NavTree`, drawn in the
buffer where a finger can reach it, and the screen the vault opens on), the
**list** a tree entry opens (`/vault?f=…`, with `/vault?f=all` as the tree's
"all" entry — the bare `/vault` is the tree), and the **item**. The tree is
mounted in exactly one place at a time — the rail above the breakpoint, the
vault's first pane below it — so two `role="tree"` never share a page. Because
the tree carries the vault's filters, nothing in the rail may become
unreachable, and the list keeps its funnel key for switching without going
back. The list's command row is not a pane away either: the same keys — new
item, whatever a capability adds beside it (Import), Export, and search — are
pinned above the tree (`VaultActions`, in the list's own `VaultPathbar`), each
at the 44px floor. The funnel and the back key stay on the list, where there
is something to filter and somewhere to go back from; the tree's search key
opens the list of everything with its prompt focused.

Prose is measured (roughly 48–62ch). A paragraph is never as wide as a panel.

### VFS interaction model

The workspace is a filesystem, not a webpage. Every vault is a tomb with a
canonical path space — `personal:/Work/GitHub` — folders are directories,
the session context is a shell prompt (`guest@personal:/` — each segment a
button that opens its switcher; never a widget stack of dropdowns),
items are files with kind pseudo-extensions (`GitHub.login`, `Deploy
webhook.secret`), and the vault list renders as a compact first-party mono
file tree (ADR 0073), never as a card wall. The navigation rail is the same
tree one level up: sections are directories off the tomb root (`vault/`,
`connections/`, `access/`, `identity/`, `wallet/`, `settings/`), each advertising its
`g`-jump key; the active section starts open but its parent row toggles
expand/collapse without changing the selected child. Arrow Left/Right use the
same behavior. Rows without children remain navigation links. The vault's
filter views, folders, and `health` — and the settings categories — appear
under their parent as entries with live counts. A path strip pins the tomb
root at the top of the vault pane; on a phone the same sections are named
rows of a drawer behind one key in the top bar.

A visible cursor row owns focus — inverse video, always rendered — and
moving it with the keyboard previews that item in the buffer, ranger's own
reading: browsing is previewing. The pane has no header; new and import are
icon keys in the path strip. Motions are vim's: `j`/`k`/arrows move, a
count prefix repeats them (`5j`), `Ctrl-d`/`u` half-page, `Ctrl-f`/`b` and
`PgUp`/`PgDn` page, `H`/`M`/`L` jump to the high/mid/low of the window,
`gg`/`0`/`Home` first, `G`/`$`/`End` last (`5G` the fifth row). `l`/`→`
dives (and from the rail, into the vault listing), `h`/`←`/`Backspace`
climbs (and from a vault root row, onto the rail). `F6` switches the two
listings when one of them holds the keyboard. `Tab`/`Shift-Tab` always follow
native control order and can leave either listing. `Enter` activates the
focused control; the tree keymap must never swallow a link or button. `/` opens
a vim-style command line at the foot of the pane, backed by a real input so
typed keys never leak into the keymap; matches highlight, non-matches hide,
`Esc` closes it and returns the keyboard to the tree. Item verbs are single
keys: `y` copies the secret, `u` the username, `e` edits, `x` trashes, `n`
creates, `.` toggles favorite, and `s` shares a secret once. `g v/c/a/i/w/s`
jumps between sections (`g` times out like vim so a stray `g` does not
swallow the next key). `Ctrl-l` / `:` focuses the command bar (browser
URL-bar style); `m` toggles push-to-speak on the mic, which is the on-device model's and drawn once it is on. `?` shows the keymap. `q{a–z}` records
what the keys run into that register until the next `q`, and `@{a–z}` replays
it (`3@a` three times, `@@` the last one again); a recording leaves out trash
and share, and is kept as the macro `q-a`. A mono status line always
shows the focused path, item count, and active filter (or the live query).
While keys are half-typed the workspace statusline shows them as small caps
beside the command field, vim's `showcmd` (`3`, `g`, `recording @a`), and on
a wide screen what each next key runs, which-key's list
(`g · v Vault · s Settings`), read from the keymap of the listing the keys
were typed in. It is a segment of the row, drawn only while
something is pending, and a phone shows the caps and the recording mark
without the list.
Pointer access remains complete: rows click, directories toggle, a `⋯` menu
on the cursor or hovered row carries the verbs, and the `/` and `?` key
chips in the path strip are buttons.

The page owns its right-click (`components/context-menu/`). A right button,
a long press (a finger or a stylus held still — recognised by the page, since
iOS sends no event for it; the lift that ends it never also taps), `Shift+F10`,
the Menu key, or `Shift+Enter` on a listing (for a keyboard with neither) opens
the app's menu for whatever it landed on — the focused row, for a key — and
every entry is a verb the page
already has, with its key beside it, so the menu teaches the keymap rather
than adding a second road. The `⋯` menu is the same list. A rail row offers
open, expand/collapse, its directory's `config.yaml`, new item, copy link and
**Show hidden items**; a Settings tab its directory's `config.yaml` too (the
touch road, where the rail is a drawer of sections); a vault row its item verbs (`Enter e y u . s x`), or
restore (`r`) and delete (`X`) in the trash; anywhere else the link, the selected text and
the page (back, forward, reload, command bar, keys, lock). A destructive entry
asks twice, re-labelled in place, like the detail pane's delete key. While a
menu is open it owns every key; Escape and Tab close it and hand focus back.
With a mouse the menu is a popover at the pointer; on a phone (coarse pointer
or ≤900px) it is an action sheet on the bottom edge — over a scrim, in reach of
the thumb, titled with what it is for, 44px entries — because a popover under
a finger would cover the very row it is about and rest on the controls around
it. The scrim's tap only dismisses; it never reaches what lies beneath.
Two things keep the browser's own menu: a text field (paste and spelling are
the browser's) and a right-click with Shift held.

Hidden items are hidden the way a file manager hides them: the vault's
`trash/` and every settings directory's `config.yaml` are left out of the rail
until its menu's **Show hidden items** is checked (per device), and are drawn
dim when they are. Hiding never closes a road — a hidden path still opens by
link, key and command bar, and the trash row is drawn while you stand in it.

Each settings directory is also a file. `settings/<category>/config.yaml`
(route `/settings/<category>?file=config.yaml` — never a `.yaml` path, which a
static host answers as a missing file) is that page spelled as YAML: the
form and the file are one set of values, so a write of the file changes the
page and a change on the page rewrites the file in place, keeping the
person's comments. State a ceremony owns (unlock methods, approved
capabilities) is listed read-only and a file that rewrites it is refused.
There is no Form/YAML/TOML switch.

The keyboard lands on arrival, every time. A page load, an unlock, a route
change, a browser Back, a switched tab — each leaves focus on `<body>` unless
the screen claims it, and from `<body>` the first Tab starts at the top of the
document, the cursor has no home, and a phone shows no keyboard. So every
screen owns its landing (`lib/focus.ts`): the unlock form's secret field (or
its go control for passkey), the first road of setup, the first vault on the
front door, the tree — or the "New item" link of an empty vault — in the
vault, and the content of a framed section. A landing yields to a caret
something else already placed (an editor's first field), and on a phone it
follows the visible pane. Opening the item the cursor already previews
replaces the history entry rather than pushing a second one, so Back always
goes somewhere.

## Touch

A finger is not a mouse pointer, and the phone is not a narrow desktop.

- **Nothing may make the document wider than the device.** Every pane in the
  grid/flex chain is pinned to `min-width: 0` so a `nowrap` row truncates
  instead of dictating the page width; a page that overflows sideways gets
  shrink-to-fit, which scales every target away from where it is drawn.
- **44px is the floor, and size is not a property of the pointer.** Every row,
  key, chip and tab is at least 2.75rem under `(pointer: coarse)` *or*
  `(max-width: 900px)` — a foldable's cover screen, a split-screen tablet and
  a narrow desktop window draw the same small keys, and WCAG 2.5.8 does not
  ask what is pointing at them. A control that opts out of the height floor to
  sit inline in a sentence (`.sent select`, `.editor__ext`) takes the shape of
  a chip at that width instead, so its rule never detaches from its own word.
  The mono density survives the change: the row grows, the type does not.
- **A field's type is the one thing that does grow.** iOS Safari zooms the page
  when a focused `input`, `select` or `textarea` is set below 16px, and it does
  not zoom back — the person is left in a viewport they cannot restore. Every
  rule that sizes a field reads `max(<its size>, var(--field-min))`; the token
  is `0` on a desktop and `1rem` under coarse/narrow, so the trap cannot be
  reopened by adding one more field style.
- **A finger gets gestures where the keyboard has keys.** The keymap is for a
  keyboard: under a coarse pointer the help row says *Gestures* and its sheet
  lists the ones the shell recognises (`lib/gesture-help.ts`) — tap opens, hold
  or swipe a row left asks for its actions, swipe right goes back, and the
  keys that matter (new, search) are visible 44px keys. A row never lists a
  gesture with no recogniser behind it. Gestures are twins, never the only
  road, and a command that asks before it acts (trash, share) is still never a
  gesture of its own — it is an entry in the actions a hold or swipe opens.
  A sideways swipe on a listing is the page's whole: `claimHorizontalDrags`
  cancels its `touchmove`, because `touch-action: pan-y` alone leaves the
  browser a fling to run, and a tap that lands on one (the menu's first entry,
  reached for the moment the sheet is up) is spent stopping it and never
  clicks. `verify:mobile` taps that entry straight after the lift.
- **Keyboard tips stay off touch-primary surfaces; one with a touch twin swaps
  to it there.** No line a finger reads names a key (`Esc`, `Enter`, `n`, `/`,
  `?`, `j/k`, `gv`). `EmptyTip` and the welcome buffer's key line draw a keys
  voice and a touch voice and the stylesheet picks one under
  `(pointer: coarse)`; copy that lives in an attribute (the command bar's
  placeholder) reads `useCoarsePointer`. A narrow window with a mouse keeps the
  keys: the pointer decides, not the width. A twin names only what the shell
  really does (see `lib/gesture-help.ts`).
- **A submenu is a drill-in, not a box.** A sheet's nested choices replace its
  list under a 44px back row that names the parent; the floating menu keeps its
  submenu beside the row. A finger is never shown the keyboard's inverse-video
  cursor: that paint belongs to `:focus-visible`.
- **Nothing waits to find out it was a tap.** Interactive elements set
  `touch-action: manipulation`, drop the platform tap highlight, and answer
  with a `:active` ink instead.
- **Every hover-only affordance has a touch twin.** The `⋯` row menu is
  revealed by hover for a mouse and by a long press for a finger; the back
  key is also a rightward swipe on the pane. Nothing is gesture-only.
- **The frame is rows, not overlays.** The statusline is a row of the app grid
  rather than a bar floating over the content, so nothing scrolls under it,
  and `env(safe-area-inset-*)` keeps it, and the sections drawer, clear of the
  home indicator.
- **The chrome earns its height.** Below 900px the phone keeps the top bar and
  one statusline row and nothing else: the sections are a drawer behind one
  top-bar key, and notifications, help, the keymap and the connection rows
  are named rows behind the top bar's overflow key. The statusline runs edge to edge, one row of 44px keys,
  and may never fold onto a second row, which costs a 568px screen a sixth of
  itself. The top bar and the statusline together stay under a third of the
  screen, rotated included.
- **Nothing floating rests on a control.** A screen with no statusline seats
  the support mark as a fixed corner overlay; the card beneath it therefore
  keeps that corner clear, and the front door tightens its own rhythm below
  720px of height so its guest road lands above the mark rather than under it.
  Clipping a control to avoid an overlay is not a fix.
- **Scrollers contain their own overscroll** and never hand a flick to the
  page behind them. A strip that scrolls (Access tabs, settings categories,
  vault chips) keeps its selected item in view — by
  scrolling the strip itself (`lib/strip.ts`), never `scrollIntoView`, which
  also scrolls every ancestor and dragged a whole section sideways.
- **One tab strip.** Access, Identity, Settings and Wallet draw the same flat
  underline strip, and on a phone every one of them scrolls in one row to the
  screen's edge. None wraps onto a second row of underlines.
- **A long page has an index.** The section drawer names sections and nothing
  else, so a page whose panels the desktop reaches from the rail (Settings ›
  Security, Settings › Connections, Connections) draws the same entries from
  the same page tree as an "On this page" strip under its tabs
  (`components/PageIndex.tsx`) below 900px. Nothing the rail links to by name
  is reachable only by scrolling.
- **The keyboard is not summoned uninvited**: a form does not autofocus on a
  touch pointer, where it would throw the keyboard over the record.
- **Keybindings is drawn only where a pointing device is attached.** Settings ›
  Keybindings is absent when `(any-pointer: fine)` is false, and its address
  lands on General; the query cannot see a keyboard, so a phone with only a
  hardware keyboard loses the tab.

None of this is a screenshot review: `pnpm --filter @opensesame/pages
verify:mobile` walks the phone journey at 320, 390, 430 and landscape in a real
coarse-pointer context and measures every rule above — and, at every stop and on
the tablets' Settings, that no key stands alone on a row
(`KEY-ALONE-ON-A-ROW`) and no field outgrows its measure
(`FIELD-WIDER-THAN-ITS-MEASURE`, `scripts/lib/layout-contract.mjs`). It
refuses to report a pass from a context that lost its touch emulation, because a check that
measures the mouse stylesheet passes for free.

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
import, save, cancel, lock, authorize, revoke, retry, load more — renders
as an icon key: a square icon button (`icon-btn`, or `.go` for the action
that ends the screen) whose `aria-label` and tooltip carry the sentence.
The verb is never painted on the button. A destructive ceremony is spelled
out in the prose beside the keys, not as a word on the key. A menu is the
exception by nature: a menu entry is a named choice in a list (with its key
beside it), and an icon-only menu would be mystery meat.

Text on a control is only the object of a choice: a provider, a mode, a
navigation target, or the guest road. Never a text verb stretched across a
row, a card foot, or an empty state. A form or ceremony that ends in an
action ends in the `.go` square with its verb beside it (`FormCommit`), and a
second action on that row — deny, keep, close — is a key beside it. A button
whose words are its choice says so by its role (tab, radio, switch, menu
entry, pressed toggle) or its class (`road`, `unlock__switch`, `choice`).
`pnpm lint:design` rejects a word-verb `<button>` that is not an icon key —
reading string literals in its face as well as its text — and the debt
ledger in `tools/quality/design-button-baseline.json` is empty.

### Status is a symbol
A status — connected, needs you, broken, revoked, saved, locked, authorized,
enabled — is a glyph (`StatusMark`), never a pill or a label with the word
painted on it. The sentence is `aria-label` and `title`, and the `title` has a
touch twin: a tap or a long press on a mark shows that same sentence, and
nothing else, in a transient `aria-hidden` bubble, over a 44px target that
moves nothing around it (a mark inside a link, button or row leaves the tap
to its parent). The glyph is one of
the existing icons: check, alert, dismiss, lock. Colour carries the tone
(ok, warn, err, idle). A name is not a status: a provider, a role, a person,
or a platform may stay text. `pnpm lint:design` rejects a `.chip` whose face
carries a status word.

An in-page error box is the same violation. A failure is never drawn in the
page: not a `note--err`, a `conn-flash`, a `broker__card--err`, a `*__error`
paragraph, a visible `role="alert"`, or any block filled with the error wash.
The failure is a `StatusMark` on the thing that failed and a notice in the
notifications tray (the bell), which announces it and keeps it when the person
leaves the screen. The tray can offer a retry when the caller supplies one
through `setStatusNotice` (`retry` / `retryLabel`); the three seam components
do not. A failure inside an `aria-modal` ceremony sheet is also the sheet's own
status line (see docs/design/controls.md § Modal ceremonies), and live
validation of an unsaved draft is a `StatusMark` on the field, not a notice. Pages mount `<FailureNotice>` (or call
`useFailureNotice`, or use `StatusNote`) and draw nothing. `pnpm lint:design`
fails on every spelling of the box.
Do not add caption or explainer prose under a title, a button, or a field:
no sentence that tells the person what the control will do, where it goes,
or why it exists. The control's `aria-label` and `title` carry that sentence.

Pages copy never names a Host. A connector action that the browser can do
itself — including creating a GitHub App — does not ask for a paired Host
and does not tell the person to pair one.

The vault pane always retains its top path-strip command group, each an icon
key with an accessible name and tooltip. Empty and filtered views use **+**,
import, and export. The trash directory uses restore and delete. That listing
does not add, import, or export. Replacing a group with text-labelled buttons
is a hard design violation, enforced by `pnpm lint:design` and the vault
render tests.

### Buttons
Ink fill for the primary action (inverting to paper-on-ink in dark mode),
surface fill with a hairline for secondary, ghost for tertiary, and a
red-tinted variant for anything destructive. One primary per view, sized to
its content — never block-width.

### Keys have a home
A key sits on the row of the thing it acts on, at that row's end — never on
a row of its own. A row of one or two bare glyphs under a field reads as
belonging to whatever comes next; on a phone it spends a whole screen-width
on a mark nobody can name without a long press. Each key has one of these
homes, and `pnpm lint:design` (`commit-key-has-a-home`) rejects a submit key
outside them:

- **A panel's keys** (new, reload, delete this vault, prove round-trip) ride
  its head, beside the title, vertically centred on it.
- **A field's keys** (save these recipients, reset these bindings) ride the
  field's label row, as wide as the field it heads, so the keys land over the
  field's own end. A multi-line field uses `.keyed-field`: the keys follow
  the field in the document, so Tab leaves the field for the key that saves
  it, and the grid only draws them on the label's row. `.keyed-row` is for a
  row whose content comes first anyway (a readout, a status).
- **The commit of a one-field form** ends the field's row: `.field-inline`,
  or a `FieldShell` `tail`.
- **The commit of a form of several fields** is `FormCommit` — the `.go`
  square with its verb beside it — because there is no single row to end,
  and a bare glyph under the label column is the mystery meat this rule
  exists for. The form's secondary keys (cancel, prefer) ride the same row.
- **A record's keys** stay on the record's row. When the name and reference
  are long they wrap; the keys fold into a block at the row's top end rather
  than dropping to a line beneath it.

### Fields have a measure
A field is sized to the value it holds, never to the panel it sits in. A
single-line field or select stops at `--field-max` (30rem); a code or prose
editor at `--text-max` (46rem). A phone never reaches either, so there every
field still fills its row. A filter in a panel head (`.head-filter`) is as
wide as its options. Readouts that belong to a field (the strength meter)
share its measure, and a matrix of marks (Formats) sizes its columns to what
they hold rather than spreading them in fractions of the page. A rule that
restates `width: 100%` for a field restates a `max-width` too — the token, or
`none` for an overlay that must span exactly what it covers — and
`pnpm lint:design` (`field-has-a-measure`) rejects one that does not.

A head's measure belongs to its prose, not to the row: a section or panel
head spans the document so a key or view switch in it ends the title's row
instead of floating at the edge of a 62ch box. A list of cards drops the
browser's list indent, and a list or grid of rows pins its track to
`minmax(0, 1fr)` so one `nowrap` label cannot widen the page.

### Forms are records
A form is a record being filled in, not a wall of boxes: each field is a
row — mono label column on the left, value on the right — and inputs are
ruled underlines on the paper (focus thickens the rule to ink). The vault
editor goes further: the item is a file, so its name is the document title,
its kind the extension beside it, and save/cancel follow all fields in both
visual and natural keyboard order. Repeatable groups grow with a `+` key beside their label.
An explicit `/vault/new/:kind` fixes the type as an extension label; only
`/vault/new` offers a type picker. Unknown types are refused with a link to
choose an installed type, never silently replaced with a login.
The title reads folder / name / type, with one folder selector before the name.
On name blur, slash paths resolve relative to the selected folder (`/` starts
at the vault root, `..` moves up), select their folder and leave only the leaf
name. New folders remain drafts until the item is saved; escaping the root or
omitting the leaf is an error, not a guessed item name.
Login Websites precedes Username. Wildcard (`*.example.com`) and regex
(`(.*\.)?example\.com`, without delimiters/flags) are explicit match modes,
applied case-insensitively to the entire hostname, never a URL path or query.
`*.example.com` excludes the apex; add `example.com` separately when needed.
The local Test match control evaluates a pattern in a disposable worker with
a one-second timeout and a 256-character pattern limit. Invalid patterns cannot
be saved; patterns are not clickable links, authorization rules or autofill.
Sealed-store manifests retain the selected mode across export/import.
Across vault item forms, optional metadata, notes, custom fields and pinning start
as explicit Add/Pin commands, not empty inputs. Commands reveal and focus the
field; existing values are always visible when editing. Clearing a revealed
field does not collapse it or discard other values. Note items keep their
primary Notes editor visible. Manifest-defined forms honor required fields;
empty optional fields use Add commands, including repeating and composite fields.
Certificate alternative DNS/IP names are opt-in, never silently prefilled.
Every type uses the shared folder/name title and native document tab order,
with Save and Cancel after the fields. Drop retention stays an explicit,
unchecked custody choice; payload and expiry remain visible.

### Settings is files
Settings' files are a file viewer, not a second form, and there is no
Form/source switch: a file is addressed like a page, `?file=<path>` on its
directory's route, reached from the rail, the command bar or a row's open key,
and Back returns to the form. A category is its document
(`settings/<category>/config.yaml`) plus the virtual files its providers
keep. For Vaults those are `settings/item-types/marketplaces.json`,
`installed/<id>.json` and read-only `builtin/<id>.json`. The files sit as a mono
tree, indented a step per directory, beside the open file. Selection is inverse
video. A new file starts from the `+` key on the directory it belongs in. A
built-in file carries the lock glyph and never a save key. The Form is drawn
from the same files, and every Form key writes one of them. A row carries a
key that opens its file. Do not draw a per-panel Visual/Source toggle or a
paste box: give the configuration a file, and the viewer shows it
([ADR 0134](docs/adr/0134-item-type-marketplaces-and-settings-files.md)).

### Keybindings are keycaps
Settings › Keybindings is a table a person reads the way they read a vimrc:
each command's name over its id, its keys as keycaps, and at the row's end
what can be done about it ([ADR 0156](docs/adr/0156-keybindings-and-macros.md)).
A keycap is a hairline cap with a heavier lower edge that sinks a pixel
under the pointer. A sequence is its caps side by side, closer together than
two separate bindings sit. A key the person added carries the accent on that
lower edge. A default they struck stays drawn, dashed and struck through, and
pressing it brings the key back; a default is never hidden. A key that
shares a prefix with another is dashed, because it waits.
A changed row carries an editor's gutter mark in the accent and a reset key.
A command that asks before it acts shows its key under the lock mark and
offers no other; if another command took that key, the key stays drawn,
struck and inert, so it is never shown as bound.

The head holds a scope choice beside the view filter, a native select:
*everywhere*, *in the vault list*, *in the rail*. Each row then draws its
keys as they hold in that scope. A key that holds in that listing only is a
keycap washed with the accent, and says where in its title and label; a key
struck there only is drawn struck, likewise labelled. Recording, conflicts,
swap, take, remove, restore, a row's reset, the changed filter and the gutter
mark all act on the chosen scope, so a key held only in the vault list is
free in the rail. A person's key for a command this plan does not have is
never invisible: it is listed under **Unavailable**, after the commands and
before **Fixed**, as its keycap and the command's id, with a status mark
that says the command is not on this plan and a remove key. There is no
caption above it.

A key is recorded where its keycap was, never in a dialog, and pressing the
Remove or Cancel key beside the field never costs it its focus. Press the key,
or a sequence, and the hairline under the field drains over the keymap's
own timeout. When it is gone, the sequence is kept. Enter keeps it at once,
Escape puts the keycap back untouched, and Tab leaves: the field never
traps the keyboard. A taken key is never overwritten quietly. The row names
what holds the key, with three keys: swap, take, keep. A key that cannot be
bound (Tab, Enter, Escape, F6, the count digits) is refused in place as a
mark while recording goes on, and those keys are listed read-only under
**Fixed**. The keyboard key in the find field switches it from words to
pressing keys. A macro opens as a record under its row, not over the page,
with its name, what it runs on, and its steps, each a count and a command.
The record key reads presses into steps the way the shell reads them. At
phone width the cap grows to the 44px target rather than floating inside it.

### Field rows
The vault's atom: a small sentence-case label, value, and right-aligned
actions. Secrets render as dots with a reveal toggle, and copy never requires
revealing first.

### Navigation
The rail renders as a mono filesystem tree (see "VFS interaction model")
rooted at the prompt line `guest@personal:/`: directory rows with counts
and g-jump key chips. Selection is inverse video (see "Selection"). The
phone section drawer lists every rail section and nothing else.
Password health is a notifications-only review, never a tree entry or vault filter chip.

Identity's children and its content tabs share the URL's `view` selection;
the rail and tabs always name the same view. Connections has separate
Connected and Add a Connection branches. Moving the connector cursor previews
the corresponding service or catalog entry in the buffer, scrolls it into view,
and outlines it in teal; the rail cursor remains inverse video. Enter or a
click opens the connector. Directional movement never starts its ceremony.
The searchable catalog grows twelve entries at a time. Load more is the final
indexed tree row, reachable by the same motions as a connector; activation
selects the first newly added entry. New rows enter over 180ms with a small
upward settle; reduced motion removes the animation.

### Tabs
Flat underline tabs on a hairline: text with a 2px accent underline for the
selected view — never boxed segmented controls.

### Local directory records
People, agents, applications, and organizations use the existing bordered
panel, identity rows, status chips, and record form. The name and stable
reference lead each row; editing opens one Name field with Save and Cancel
after it. While a draft is open, New and other row mutations are disabled.
Failed saves retain the draft and return focus to its field; closing the
form restores its initiating control when focus has not moved elsewhere.
Deletion requires an explicit confirmation. The panel states that these
records are local to the encrypted vault; creating a record alone grants
no resource access. Broader identity and access management remains incomplete.

### Local identity passkeys
Each People row has a native Passkeys disclosure. Opening it loads that
person's credentials; Enroll passkey and Sign in locally load the human
ceremony only when pressed. Credential rows stay flat inside the person row,
separated by hairlines, with a short credential suffix and enrollment date.
Pending results use inline outputs and errors use alerts. Disabled people
cannot enroll or sign in, but their credentials can still be revoked.

Revoke passkey becomes Confirm revocation beside Keep passkey. Keeping it
returns focus to Revoke passkey; successful removal returns focus to the
Passkeys summary only when the removed control held focus and focus has fallen
to the document body. Focus elsewhere is preserved.

Sign in locally verifies a passkey and shows the active local session and its
expiry; Sign out locally revokes it. Closing the disclosure or navigating away
does not sign out: reopening validates the stored session. Directory changes
(including disabling and re-enabling a person or changing a role), expiry, or
revoking its passkey require a fresh sign-in. Inline status explicitly reports
that no application access was granted; local authentication is not a claim
that broader IAM is complete.

### Local agent keys
Each Agents row has a native Agent keys disclosure. Public ES256 credentials
appear as flat, hairline-separated rows with a key suffix and enrollment date.
Enroll public key reveals and focuses a labeled Public key JWK textarea;
Save public key and Cancel enrollment follow it. Failed saves retain the draft.
Private keys are never requested. Disabled agents cannot enroll or authenticate,
but their keys remain revocable.

Authenticate agent opens a read-only, one-use challenge followed by a Signed
challenge textarea and Verify agent / Close challenge actions. The challenge
expires after two minutes; a failed verification requires a new challenge.
Its arrival focuses the challenge only if focus remains at the initiator or
has fallen to the body. Native fields scroll internally and record/action rows
wrap at narrow widths, retaining the existing typography and focus treatment.

Status distinguishes machine authentication from human approval and application
access; neither is granted by this session. Sign out agent revokes the session.
A read failure reports Local session unavailable, never an absent-session claim.
Revoke agent key requires Confirm key revocation or Keep agent key. Keeping it
restores the revoke control; closing a form or removing a key restores the
connected initiating control, or the disclosure summary if it was removed,
only when focus fell to the body. Focus moved elsewhere is preserved. This
pattern documents local agent authentication, not local application delegation
or completion of browser IAM; it introduces no raster imagery or new tokens.

### Local authenticators in Devices
Without a configured Identity API, Identity → Devices presents Authenticators
with the existing Reload directory icon. A short scope notice explains that
synced passkeys may span devices; the list describes this vault's sign-in keys,
not physical hardware. People and agents retain their name, wrapped public
reference and enabled state in the incumbent bordered identity rows. Their
native Passkeys and Agent keys disclosures reuse the enrollment, local sign-in
and confirmed revocation controls documented above. Credential rows remain
hairline-separated; actions wrap on mobile with visible teal keyboard focus.

Loading and read errors remain distinct from emptiness; an empty directory
links to Create a person. A failed directory read disables credential mutations
until recovery. Directory changes refresh the list. If a whole principal is
removed, Reload receives focus only when the previously focused control was
disconnected and focus fell to the body; deliberate focus elsewhere survives.
This extension introduces no tokens or imagery and does not establish completion
of broader browser IAM.

### Local organization members
Each organization row has a native Members disclosure. Existing members appear
as flat, hairline-separated rows with their names, role chips, and confirmed
removal. Keep member restores the removal button; confirming removal moves
focus to Members before the row changes. Errors remain in the directory panel.

The custodian assigns membership with labeled native Person or agent and
Organization role selects. Selecting an existing member loads its role and
changes Add member to Save role. People may be members, admins, or owners;
agents remain members. Empty organizations ask for an enabled person as the
first owner; removing, demoting, or disabling the last enabled owner is refused.
Role changes require local sessions to sign in again. These controls retain
the incumbent row wrapping, typography, hairlines, and focus treatment.

A signed-in person reads their own organizations under their local session:
an Organizations label and one mark, then a native disclosure per
organization with its role beside the name. Opening one lists its members as
the same flat rows. Keys appear only where the session's role permits: an
owner gets a Role select with a Save role key on each person and the armed
Remove member key on everyone; an admin gets removal on ordinary members;
a member, and any agent-key session, gets no keys. The keys stay enabled
while a change is pending, so focus is never dropped. A refusal is the
organization's mark. A committed change ends every local session, so the
session mark says so and Sign in locally takes focus.

### Local application registration
Access → Policies reuses this same registration disclosure from Identity →
Applications, backed by the same encrypted store and role evaluator. Each
application keeps its name and stable public identifier together; the identifier
wraps beneath the name using the existing muted reference treatment. The panel
introduction keeps the established readable prose measure. Local policies work
without Host, with Host policies presented independently.

Each Applications row has a native Application registration disclosure. Its
record form uses a labeled Organization select, a bordered, vertically
resizable Redirect URIs textarea (one exact callback per line), and an
Allowed scopes input (space separated, including `openid`). Organizations
must be enabled and have an owner; when none qualify, the hint directs the
custodian to create an organization and assign its first owner. The controls
reuse the existing mono labels, ruled fields, hairlines, and focus treatment.

Roles allowed per scope follows the scope names, before Save registration.
Each scope groups native owner, admin, and member checkboxes; unchecked roles
are denied, including owners. New custom scopes start entirely unchecked.
Tab and Space retain native behavior, and role rows wrap on narrow screens.
Role choices share the retained draft and encrypted save/reload behavior;
selecting a role never replaces explicit sign-in consent.
Saving a changed policy invalidates existing application grants and requires
a new sign-in and explicit consent. Disabled applications remain visible with
their editor disabled; loading, safe read failures, and no applications are
distinct states. A failed directory refresh disables editing until recovery.

Save registration persists the encrypted configuration; Reload registration
reads it again. Loading and read errors never become a not-registered claim.
Failed saves retain the draft for correction or retry. Remove registration
becomes Confirm removal beside Keep registration; keeping it returns focus
to Remove registration. After a save, focus returns to the initiating control
only if it is still connected and focus fell to the document body; after
removal, the disclosure summary provides that fallback. Focus moved elsewhere
is preserved.

Inline status distinguishes registration from authorization. Exact HTTPS
callbacks (or loopback HTTP for development) and allowed scopes configure
admission; they do not issue tokens, grant sign-in or resource access, or
establish completion of browser IAM (ADR 0106).

### Local application consent
The consent panel leads with the application name and requesting origin; a
native disclosure reveals the exact callback. Agent requests also name the
agent and disclose its identity and enrolled public key reference, followed
by requested scopes. The native Approving person selector lists enabled owners
and admins in the application's organization. Verify with passkey precedes a
separate Allow agent access action beside Deny. Person requests retain Person
and Allow application. Inline outputs report connection state, alerts carry
failures, and active connections offer End application session. Controls reuse
the existing record layout, ink action and teal focus; long references wrap.
This pattern records the consent surface, not completion of broader browser IAM.

### Local requests
Access → Requests uses the existing panel with New and Reload icon commands,
flat ruled rows, a truthful count, and wrapped public request references.
One inline fieldset opens at a time. Creation reuses local person/agent
authentication and labeled native fields for application, exact registered
callback, scopes and reason; failures retain the draft. Status is an inline
output and read failures remain alerts, distinct from an empty list.

Review names the requester, application, organization, reason, scopes and
callback. Only pending requests offer an authorized-person selector and
request-bound Approve with passkey / Deny with passkey actions. The open review
resolves its record by ID against current data: expiry and external decisions
remove obsolete approval controls. Active focus is preserved; disappearing
controls or records restore useful focus within the review or to the connected
initiator, falling back to Reload. Withdrawal and settled-history removal each
require confirmation. Native controls, ink actions, teal focus and wrapping
action rows retain the incumbent desktop/mobile treatment.

Requests expire after five minutes. Creation grants no access; approval never
bypasses application policy. Popup application consent now creates a transaction-
bound request, obtains a fresh request-bound passkey decision, consumes approval
once, then issues through the existing PKCE code flow. The binding covers the
client, callback, scopes, state, nonce, PKCE and agent. An organization member
may consent only to their own bound sign-in; manual and agent requests require
an owner or admin. The same role-eligibility rule drives review controls and
enforcement. This describes the connected popup flow, not completion of broader
IAM or its full validation gates.

### Local sessions and grants
Access → Grants reuses this panel in a grant-only variant, showing encrypted
application grants without requiring Host. Access → Sessions retains the combined
sessions-and-grants ledger. Host delegation controls remain independently
available when configured. Flat, hairline-separated rows name the principal and application, with
scope, expiry and exact public record references. Counts describe recorded,
unexpired sessions and grants, never live connections; empty counts use a dash.
Loading and read failures remain distinct from an empty ledger.

Both variants use the same confirmed revocation. An inline fieldset names the exact record and consequence,
with Confirm revocation and Cancel revocation. Cancel receives initial focus;
closing returns focus to the source control, or Reload if the row was removed,
only when focus is idle. Moved focus is preserved. Success uses inline output;
failures remain alerts with reload/retry recovery. Long references and mobile
action rows wrap within the existing panel, using the incumbent ink buttons,
hairlines and teal focus treatment. Native focus scrolling brings confirmation
and restored controls into view; introductory prose keeps the readable measure.

### Callouts
`note` with `--ok`, `--warn`, `--err` variants for a stated condition. Live
regions are `<output>`, control groups are `<fieldset>`, so the accessibility
role comes from the element rather than an attribute.

### Empty states
An empty state must say what would be here and why it is not — offline,
unauthenticated, or genuinely empty — and offer the action that fills it, as
plain text with no icon tile. Vault commands stay in the top path strip, not
in a second empty-state button row. The vault's unselected buffer is two mono
lines: what is sealed, and the keys — because moving the cursor previews
items, there is nothing else for it to say. Password-health warnings live in
the global notifications panel so they remain visible from every section.

## Do's and Don'ts

### Do:
- **Do** conceal secret values by default and allow copying without revealing.
- **Do** state what a network-backed surface cannot show while offline or
  unauthenticated.
- **Do** treat a reload re-locking the vault as correct behavior and say so.

### Don't:
- **Don't** add a shortcut around the master password. A passkey or PIN may
  unlock the vault, but each is an alternate wrap of the same vault key,
  entered every time — never a remembered device and never a recovery path.
- **Don't** put a secret, or a hash of one, on the network.
- **Don't** let prose run the full width of a panel.
- **Don't** leave a key alone on a row under the field it commits; give it a
  home (§ Keys have a home).
- **Don't** let a field, select or filter grow to the width of its panel
  (§ Fields have a measure).
- **Don't** make a phone scroll a long page to reach a panel the rail names.
- **Don't** clone Bitwarden's brand identity.
