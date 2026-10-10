---
name: OpenSesame
description: End-to-end encrypted vault for humans, agents, websites, and developers
colors:
  canvas: "#fafafa"
  surface: "#ffffff"
  surface-2: "#f0f0f0"
  surface-3: "#e2e2e2"
  rail: "#fafafa"
  rail-fg: "#171717"
  ink: "#171717"
  ink-2: "#4d4d4d"
  ink-3: "#666666"
  line: "#e0e0e0"
  line-strong: "#bdbdbd"
  mark-slit: "#8f8f8f"
  scrim: "rgba(0, 0, 0, 0.44)"
  ok: "#171717"
  warn: "#5c5c5c"
  err: "#171717"
  ok-wash: "#efefef"
  warn-wash: "#e6e6e6"
  err-wash: "#d9d9d9"
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
    fontFamily: "system sans stack (-apple-system, BlinkMacSystemFont, Segoe UI, …)"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system mono stack"
    fontSize: "0.75rem"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.875em"
rounded:
  md: "0"
  lg: "0"
spacing:
  sm: "0.4rem"
  md: "0.9rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "0 0.85rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 0.85rem"
  panel:
    backgroundColor: "transparent"
    rounded: "{rounded.lg}"
  item-row:
    backgroundColor: "transparent"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
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
black-and-white foundation, greys for everything that is not ink, and nothing
decorative but the brand's own plates.

**Key characteristics:**
- A new vault is sealed by a passkey, or a PIN where WebAuthn cannot run
  ([ADR 0180](docs/adr/0180-vaults-are-sealed-by-passkey-not-password.md)):
  no master password to create, no PIN theater, no recovery promised
- One paper surface: the whole workspace is a light, hairline-divided
  terminal — mono filesystem rail, content buffer, statusline. Dark mode
  inverts the same system onto near-black paper.
- No hue. Focus, links and the brand are ink; status is a glyph, a texture
  and a lightness; the one grey the brand keeps is the slit of light in the
  mark (`--mark-slit`). Primary actions are ink, and the cursor is inverse video.
- Scandinavian restraint: zero-spread neutrals, sentence case everywhere,
  hairline rules and chapters instead of boxed cards, square corners (no
  radii), no decorative gradients or shadows
- List-and-detail spine for the vault; flowing chapter documents for the
  plane-backed sections
- System font stacks for the interface — no third-party origin; the wordmark
  alone sets in a bundled, self-hosted face (OS Logo: Geist Mono ExtraBold,
  subset to `0-9 A-Z space`, OFL)

## Mark

The mark is **the door ajar**: the vault slab slid aside with a slit of
light where it opened — Open Sesame's own story, drawn as two sharp
rectangles. One geometry, pinned in `components/CipherWordmark/mark-geometry.ts`
in units of the mark's height divided by 17 — slab 12u, gap 2.7u, slit 2.3u —
so the footprint is a square; `IconMark`, `public/icon.svg` and the slab the
wordmark paints all derive from it, and `mark-geometry.test.ts` holds the icon
to it. The slab is ink; the slit is `--mark-slit`, a mid grey (#8f8f8f on
paper, #666666 at night), decorative and the one thing that colour is used
for. It was teal once; nothing in the brand carries a hue now. In the chrome
the mark is bare — no tile, no circle, no badge — beside the uppercase name.
The app icon is a square #141414 tile with the mark 36 tall at a 14 inset; a
platform rounds its icons itself.

The wordmark is the name, `OPEN SESAME`, punched out of eleven plates on a
canvas (`components/CipherWordmark`), set in OS Logo at weight 800 — the one
display face and the one weight past 600, used nowhere else. The brand spells
it with the letter O: a zero is one word to change (`DISPLAY_WORD`), and the
default stays the letter because a zero makes the eye and the screen reader
disagree. One plate grid, three renderings by em (`particles-model.ts`):

| Tier | Em | Drawn | Where |
| --- | --- | --- | --- |
| field | 48px and up | ink particles with the letter cut out; the field drifts while the name decrypts, then freezes | the front door, fitted to its card (`fit`: em = width / 7.78, at most 90) |
| solid | 16 to 48px | a solid ink plate with the letter cut out, stroked so it survives 1× | the unlock card, the setup bar at tablet width |
| type | under 16px | the letters in ink, no plates | the rail (12px), the setup bar (13px) |

An 11px particle plate keeps 290 of its 1,400 cut-out pixels and reads as
redacted blocks, so the small tiers exist. The element's font-size is the
plate em, so a stylesheet sizes the wordmark the way it sizes text.

The name decrypts on arrival: every cell starts as hex ciphertext — the
glyphs a digest is written in — and a cursor walks the cells left to right,
the active plate brightening (never a stroked frame) while its glyph steps at
35ms a frame for 6–12 frames, then locks on its letter and flashes once.
2.31–4.62s in all, once per session: the gate a person arrives on owns the
moment, and every wordmark mounted after it — the setup ceremony, the rail —
stands still on its letters. The unlock screen's wordmark replays it on each
mount. The plates are decorative; assistive technology reads `open-sesame`
once. Reduced motion shows the finished word at once, the field frozen.
`verify:static` samples the real page (`scripts/lib/wordmark-contract.mjs`):
the published slot timings, one cursor cell at an injected clock, the settled
plates under reduced motion.

## Colors

Neutrals carry the interface. There is no accent: the greyscale system
(#1001) retired teal, and focus, links and the brand are ink.

### Primary
- **Mark slit** (#8f8f8f, #666666 at night): the slit of light in the mark,
  and nothing else. Decorative, at the 3:1 floor and no higher. Primary
  buttons are ink, a tree cursor is inverse video, focus is an ink ring.

### Neutral
All neutrals are zero-spread grays — no warm or cool casts anywhere in chrome.
- **Rail** (#fafafa): the navigation plane shares the canvas — one paper
  surface, separated from the buffer by a hairline, not a color change.
- **Canvas** (#fafafa): the ground everything sits on.
- **Surface** (#ffffff): the lifted layer — sheets, menus, the drawer, the top
  bar, notice cards and secondary buttons. A `.panel` is unboxed.
- **Ink / Ink-2 / Ink-3** (#171717 / #4d4d4d / #666666): the ink ladder —
  primary, supporting, and metadata text, stepped like alpha-black on white
  (roughly 100% / 70% / 60%). The lowest rung stays above 4.5:1 on white.
- **Surface-2 / Surface-3** (#f0f0f0 / #e2e2e2): the two steps below the
  surface — a hovered row, a pressed key, the armed key's twin.
- **Line / Line-strong** (#e0e0e0 / #bdbdbd): every hairline, and the edge a
  focused field or a selected tab's bar strengthens to.

### Status
A status is a glyph and a shade, never a hue (`docs/design/color-vision.md`):
**ok** is ink (#171717) on its wash (#efefef), **warn** a darker grey
(#5c5c5c) on #e6e6e6, **err** ink again on the deepest wash (#d9d9d9), **idle**
the lock glyph. The four read apart by shape first and wash second, and the
same four values serve at night stepped from the night canvas. The password
strength ramp (`--s-0` … `--s-4`) counts five segments
filled in ink; level reads by count, not hue.

### Named rules

**The Competitor Marks Rule.** Match Bitwarden's habits, never its brand.

**The Honest Crypto Rule.** Every claim in the interface is one the code makes
true. If copy says nothing leaves the device, nothing leaves the device — the
health report is computed locally and contacts no breach service, and TOTP codes
are derived in the page.

**The No-Recovery Rule.** The absence of a recovery path is stated before the
vault is created (the first-run seal form says "There is no recovery" for the
passkey or the PIN it is sealing with), acknowledged with a checkbox, and
repeated where it matters. Never soften it.

## Typography

The chrome speaks mono — the terminal voice. Every control, heading, label,
navigation entry, and data value sets in the system mono stack at 14px.
Prose is the one exception: paragraphs and hints read in the system sans
stack at a readable measure, because explanations are for reading, not
scanning.

### Hierarchy
- The front door's title is the wordmark at display scale — fitted to its
  card, em = width / 7.78 capped at 90px, the one display step, used nowhere else
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
keys and the command bar. The command bar in the statusline is the chrome's
one typed field: a command runs, and a sentence it cannot parse goes to
Support as a question, so nothing else in the frame asks to be typed into.
The vault, Identity, Access and Wallet add a 21rem list column between rail and
detail, giving ranger's three panes. Their records share the compact file rows,
pathbar commands, ruled details and explicit create/edit buffer. Connections
keeps its existing document layout.

Below 900px the rail gives way to a slim top bar: Sections, the current section
name, Lock, and More. The Sections drawer groups account and vault switching
with navigation; More holds appearance, installation, and secondary utilities.
The statusline keeps the command, and record sections collapse to one pane at a
time, each with a back key and
a back swipe: the **section tree** (the rail's own `NavTree`, drawn in the
buffer where a finger can reach it, and the screen the vault opens on), the
**list** a tree entry opens (`/vault?f=…`, with `/vault?f=all` as the tree's
"all" entry — the bare `/vault` is the tree), and the **item**. The tree is
mounted in exactly one place at a time — the rail above the breakpoint, the
vault's first pane below it — so two `role="tree"` never share a page. Because
the tree carries the vault's filters, nothing in the rail may become
unreachable, and the list keeps a way to switch without going back.

**A phone does not get a desktop's strip of icon keys.** Four thin glyphs in a
row at the top (a funnel, a down arrow, an up arrow) are a guess nobody can
read, and the top of a tall screen is the hardest place to reach. The section
tree stays the sections and nothing else — no key strip, no tool rows. The
phone's actions are redrawn for a thumb:

- **The list's header** is back and the view it is showing, *named* — `All
  items ▾`, one choice the width of the rest and 48px tall
  (`VaultFilterMenu`), in the accent colour while it narrows the vault.
- **Adding is one button, in the bottom corner** (`NewItemFab`): the `+`, a
  56px sharp square, is the default and one tap. It has no ellipsis and opens
  no sheet. **Holding it draws a drag area** (`AddSlide`): a square zone above
  the button and one below, each named beside it — slide up to Import, slide
  down to Export — and the zone under the finger is inked. Letting go on a
  zone runs it; letting go anywhere else, or a cancelled touch, chooses
  nothing, and the lift that ends a hold never follows the `+` link. A
  keyboard, a mouse or a screen reader, which cannot slide, still gets `Add
  actions`, the app's own context menu of the same entries; a held finger never
  opens it. The drag area is drawn on the body in fixed coordinates, because
  the vault's box clips. The button is drawn in the vault's box, which never scrolls (its rows do), so it
  is always under the thumb, above the pane's status line and clear of the
  prompt; the last row pads past it. The item's screen and the trash draw
  none. Rows pass beneath it as they scroll, as in any phone app.
- **A flow behind that menu is a `vault-command`'s `Entry`**: mounted beside
  the button, it registers its menu entry (`add-menu.ts`) and draws its own
  sheet and nothing else; its `Command` is the icon key a desktop's list
  shows. Import and Export are the same flows either way.

**Search is a verb of the one text input, never a second box.** The
statusline's prompt lists `search` in its hint, and `/? words` (or `/search
words`) is typed into it. The words are published as they are typed
(`lib/command-bar/search.ts`) and whichever listing is on screen — the vault,
Activity, the connector catalog — narrows to them live, with the count in its
status line. Enter keeps the words in the field, hands the keyboard to the
listing (or brings up the vault's list when nothing on screen is searching),
and opens no notice over the prompt; Esc, in the field or the list, empties it.
Words typed for one section are dropped when a person goes to another by any
other road. There is no search key and no search field in any listing pane
(Settings › Vaults › Item types draws its own); the `/` key writes `/? ` into
the prompt and focuses it. A bare `/?` is still help. `verify:mobile` counts
the text inputs on the vault's list screen and fails on a second.

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
`connections/`, `access/`, `identity/`, `wallet/`, `activity/`, `settings/`;
all but `vault/` and `settings/` are contributed by capabilities), each
advertising its `g`-jump key; the active section starts open but its parent
row toggles
expand/collapse without changing the selected child. Arrow Left/Right use the
same behavior. Rows without children remain navigation links. The vault's
filter views and folders — and the settings categories — appear under their
parent as entries with live counts. The vault pane's path strip holds the crumb
trail and the pane's command keys, and the pane's status line carries the tomb
path; on a phone the same sections are named rows of a drawer behind one key
in the top bar.

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
focused control; the tree keymap must never swallow a link or button. `/`
writes `/? ` into the statusline's command bar and focuses it, a real input
so typed keys never leak into the keymap; matches highlight, non-matches hide,
`Esc` empties it and returns the keyboard to the tree. Item verbs are single
keys: `y` copies the secret, `u` the username, `e` edits, `x` trashes, `n`
creates, `.` toggles favorite, and `s` shares a secret once. `g v/c/a/i/w/y/s`
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
on the cursor or hovered row carries the verbs, and the `?` key in the path
strip is a button.

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
form and the file are one set of values, and the file's view **is the page**.
Opening it draws the page the directory already draws, with the rail's row
selected, exactly as every other page is drawn; it never draws its text. State
a ceremony owns (unlock methods, approved capabilities) is listed read-only
and a file that rewrites it is refused. There is no Form/YAML/TOML switch, and
no page is a text editor.

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
  sit inline in a sentence (`.sent select`) takes the shape of a chip at that
  width instead, so its rule never detaches from its own word. The editor's
  title row is one path control (`.pathfield`, [ADR 0181](docs/adr/0181-the-title-row-is-one-path-control.md)):
  folder first, name, type last, the two special parts in the accent ink and
  each a combobox that holds only a value from its list, every part 44px.
  The mono density survives the change: the row grows, the type does not.
- **A field's type is the one thing that does grow.** iOS Safari zooms the page
  when a focused `input`, `select` or `textarea` is set below 16px, and it does
  not zoom back — the person is left in a viewport they cannot restore. Every
  rule that sizes a field reads `max(<its size>, var(--field-min))`; the token
  is `0` on a desktop and `1rem` under coarse/narrow, so the trap cannot be
  reopened by adding one more field style.
- **A finger gets gestures where the keyboard has keys.** The keymap has two
  loadouts ([ADR 0170](docs/adr/0170-gesture-loadout.md)), and the device leads
  with the one it is used with: under a coarse pointer the help row says
  *Gestures* and its sheet lists the ones the shell recognises
  (`lib/gesture-help.ts`) — tap opens, hold
  or swipe a row left asks for its actions, swipe right goes back, swiping a
  page with tabs turns to the next or the previous tab, then the
  two-finger swipes, the two-finger tap and the shake in force — and what
  the vault's first pane asks of a thumb is drawn for one: search is the
  status-line prompt (`/? words`), the one text input on the screen, and adding
  is one button in the bottom corner — a `+`, with Import and Export a hold and
  a slide away — not the desktop's row of small keys. A row never lists a
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
  top-bar key alongside account and vault switching. Notifications, help,
  the keymap, installation, appearance, and connections sit behind More.
  The statusline runs edge to edge, one row of 44px keys,
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
- **Keybindings is drawn on every device, as two tabs.** Settings › Keybindings
  has a Keyboard tab and a Gestures tab, and opens on the one the pointer in
  use is (a finger lands on Gestures). Neither is withheld: a phone with a
  hardware keyboard keeps the keys, and a touch laptop keeps the gestures. Under
  `(pointer: coarse), (max-width: 900px)` the tabs are 44px, and a gesture's
  row is its name over its choice at the full width of the panel, the reset key
  at the end of the name's line.

None of this is a screenshot review: `pnpm --filter @opensesame/pages
verify:mobile` walks the phone journey at 320, 390, 430 and landscape in a real
coarse-pointer context and measures every rule above — and, at every stop and on
the tablets' Settings, that no key stands alone on a row
(`KEY-ALONE-ON-A-ROW`) and no field outgrows its measure
(`FIELD-WIDER-THAN-ITS-MEASURE`, `apps/pages/scripts/lib/layout-contract.mjs`); it also opens
the Settings files (`apps/pages/scripts/lib/settings-file-contract.mjs`) and holds the
list above the open file, 44px rows and a 16px editor. It
refuses to report a pass from a context that lost its touch emulation, because a check that
measures the mouse stylesheet passes for free.

## Elevation & Depth

Hairline borders carry structure; shadows exist only where elevation
communicates behavior (menus, popovers, the unlock card), and even there they
are neutral and barely visible. Panels are neither boxed nor floated: a
hairline under the head carries the structure. Rows are flat with hairline
separators.

## Shapes

All-sharp, no scale. Every corner is square: `--radius` is 0 and stays 0, on
every control, chip, badge, menu, panel and sheet, and a focus ring follows the
square. **There are no round corners** — no pill, no circle, no percentage and
no radius at all, not even 2px. A status dot, a switch knob, a spinner and the
phone's Add are squares. This is a design violation, not a taste:
`pnpm lint:design` (`no-round-corners`) resolves every `border-radius` to
pixels and fails any past 0, or any it cannot prove square. The ledger
`tools/quality/design-radius-baseline.json` is empty and stays empty; a new
file meets the rule outright. The mark is
bare in the chrome; only the OS app icon keeps a tile and its platform
mask.

## Selection

Selection is inverse video, the terminal's own idiom: the tree cursor, the
rail's current leaf, and pressed toggles render paper-on-ink. Exactly one
row in a tree is inverse at a time — the open directory above a selected
leaf shows only its open caret and weight. Colour never marks selection.

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
action ends in the `.go` square with its verb beside it (`FormCommit`, and
`CeremonyShell` for every ceremony card), and a second action on that row —
deny, keep, close — is a key beside it. A verb handed to a component in a
prop is still a verb on a button: `pnpm lint:design` fails a text button
whose face is a prop (`word-slot`).

A confirmation sheet is its mark, its name and its close key, then one card:
the object the act touches, the facts that justify it ("After", "Untouched"),
and the act's own `.go` square with the bin on it. The close key is the one way
out, and where the keyboard lands; there is no second Keep key (`one-way-out`),
and no red on any control. It wears no warning wash and no kicker —
an ask has not failed — and no caption under the title or in a foot
(`docs/design/controls.md` rules 10–13). A button
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
A `.hint` line is a fact (`Enrolled {date}`, `Callback: {url}`), never a
sentence about the control: `pnpm lint:design` fails any `hint` of five words
or more, on every screen (`no-hint-caption`), and `FieldShell` takes no `hint`.

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
surface fill with a hairline for secondary, ghost for tertiary. There is no
red variant: red is a status (a `StatusMark`, the tray card, an `aria-invalid`
border), never paint on a control, and a destructive act is the ordinary
primary with the bin glyph, a card that names what goes, and the close key as
the safe road (`no-danger-control`, `no-control-error-ink`). One primary per
view, sized to its content — never block-width.

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
A settings page and its files are one thing, and the page is how a person sees
them. A directory's own document (`settings/<category>/config.yaml`) and the
capability documents behind Capabilities (`installation-selection.yaml`,
`instance-policy.yaml`, `effective-plan.yaml`) are real files in the tree that
the rail, the command bar and an old link open by path, and opening any of them
draws the designed page that writes it: the same tiles, switches and fields as
the page itself, never the file's text. There is no Form/source switch and no
page that is a text editor. Where a configuration has no designed row, give it
one (add the designed row on the page that owns the key); do not fall back to
showing YAML. Host/Identity/daemon are not Pages backends — there is no
Endpoints panel for those addresses (ADR 0090).

Only a file a provider keeps *for authoring* opens in the file viewer: an item
type's `installed/<id>.json` and read-only `builtin/<id>.json`,
`settings/item-types/marketplaces.json`, a routing file. They are addressed
like pages, `?file=<path>` on their directory's route, reached from a row's
open key, and Back returns to the page. The files sit as a mono tree, indented
a step per directory, beside the open file; the painted text is the same
colour-coded copy in every one. Selection is inverse video. A new file starts
from the `+` key on the directory it belongs in. A built-in file carries the
lock glyph and never a save key. The Form is drawn from the same files, and
every Form key writes one of them
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

Keyboard and Gestures are tabs over a hairline, as Installed and Marketplace
are: text, with a 2px ink rule under the chosen one. The Gestures tab is a
list, not a table of keycaps: a gesture's glyph (two dots trailing an arrow for a
swipe, a ring about each for a tap, a phone between two swings for a shake),
its name over its id, and what it runs as a native choice, grouped as the
keymap's rows are and ending with the person's macros. "No action" strikes a
gesture. A command that asks before it acts is not a choice at all. A change is
the same gutter mark and reset key a keyboard row carries; the fixed gestures sit
under the lock. The motion switch is not drawn where the browser has no motion
sensor, and its Allow key only where the browser asks first.

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
Password health is a review page. The vault tree lists it as `health`,
after favorites and before the type directories, on a wide screen and on
a phone's first pane. Choosing it opens `/vault/health`. It is not a
vault filter chip: the filter sheet does not link it, and it does not
narrow the list. When the report has findings, the notifications sheet
still carries Review passwords.

Identity's children and its content tabs share the URL's `view` selection;
the rail and tabs always name the same view. Connections has separate
Connected and Add a connection branches. Moving the connector cursor previews
the corresponding service or catalog entry in the buffer, scrolls it into view,
and outlines it in ink; the rail cursor remains inverse video. Enter or a
click opens the connector. Directional movement never starts its ceremony.
The searchable catalog grows twelve entries at a time. `Load n more` is the final
indexed tree row, reachable by the same motions as a connector; activation
selects the first newly added entry. New rows enter over 180ms with a small
upward settle; reduced motion removes the animation.

### Tabs
Flat underline tabs on a hairline: text with a 2px ink underline for the
selected view — never boxed segmented controls.

### Local directory records
People, agents, applications, and organizations use the existing
panel, identity rows, status marks, and record form. The name and stable
reference lead each row; editing opens one Name field with Save and Cancel
after it. While a draft is open, New and other row mutations are disabled.
Failed saves retain the draft and return focus to its field; closing the
form restores its initiating control when focus has not moved elsewhere.
Deletion requires an explicit confirmation. These records are local to the
encrypted vault; creating a record alone grants no resource access. Broader
identity and access management remains incomplete.

### Local identity passkeys
Each People row has a native Passkeys disclosure. Opening it loads that
person's credentials; Enroll passkey and Sign in locally load the human
ceremony only when pressed. Credential rows stay flat inside the person row,
separated by hairlines, with a short credential suffix and enrollment date.
Pending results use inline outputs; a failure is a `StatusMark` with a
visually hidden alert, not a box. Disabled people
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

### Local browsers in Devices
Identity → Devices lists the browsers that have opened this vault in a
Browsers panel with a Reload browsers icon key in its head. Each browser lists
itself when it unlocks the vault; a row names the browser and its reference,
its platform, when it was added and when it was last seen, and a `StatusMark`
says whether it is this device. The pencil renames a browser through one Name
field with Save changes and Cancel after it; a trash key removes one, armed by
the first press with a keep beside it, and this browser's own row has no
remove key. Loading, an empty list, unavailable browser storage and a read
failure are `StatusMark`s on the head, distinct from one another, never a box.
The tailnet's machines (when device management is on) lead the tab above it,
and the directory's Approve a device card, where an Identity API is configured
and a session exists, follows it.

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
must be enabled and have an owner; when none qualify, the hint reads `No
organizations yet.` The controls
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
and Allow application. Inline outputs report connection state, failures go to the
tray, and active connections offer End application session. Controls reuse
the existing record layout, ink action and ink focus; long references wrap.
This pattern records the consent surface, not completion of broader browser IAM.

### Local requests
Access → Requests uses the existing panel with New and Reload icon commands,
flat ruled rows, a truthful count, and wrapped public request references.
One inline fieldset opens at a time. Creation reuses local person/agent
authentication and labeled native fields for application, exact registered
callback, scopes and reason; failures retain the draft. Status is an inline
output and read failures go to the tray, distinct from an empty list.

Review names the requester, application, organization, reason, scopes and
callback. Only pending requests offer an authorized-person selector and
request-bound Approve with passkey / Deny with passkey actions. The open review
resolves its record by ID against current data: expiry and external decisions
remove obsolete approval controls. Active focus is preserved; disappearing
controls or records restore useful focus within the review or to the connected
initiator, falling back to Reload. Withdrawal and settled-history removal each
require confirmation. Native controls, ink actions, ink focus and wrapping
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
Access → Grants shows the encrypted application grants and Access → Sessions
the sign-in sessions, one record kind per tab from the same panel, neither
requiring Host. Flat, hairline-separated rows name the principal and application, with
scope, expiry and exact public record references. Counts describe recorded,
unexpired sessions and grants, never live connections; empty counts use a dash.
Loading and read failures remain distinct from an empty ledger.

Both variants use the same confirmed revocation. An inline fieldset names the exact record and consequence,
with Confirm revocation and Cancel revocation. Cancel receives initial focus;
closing returns focus to the source control, or Reload if the row was removed,
only when focus is idle. Moved focus is preserved. Success uses inline output;
failures go to the tray, with reload/retry recovery. Long references and mobile
action rows wrap within the existing panel, using the incumbent ink buttons,
hairlines and ink focus treatment. Native focus scrolling brings confirmation
and restored controls into view; introductory prose keeps the readable measure.

### Callouts
`note` with `--ok` and `--warn` variants for a stated condition; there is no
`--err` variant, because a failure is a `StatusMark` and a tray notice. Live
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
- **Don't** add a shortcut around the vault's key. A passkey, a PIN or (on a
  vault that already holds one) a master password is a wrap of the same vault
  key, entered every time — never a remembered device and never a recovery
  path.
- **Don't** put a secret, or a hash of one, on the network. (The one
  exception is the opt-in `vault.security-checks` capability, which sends the
  first five hex characters of a password's SHA-1 to the Pwned Passwords range
  API, [ADR 0080](docs/adr/0080-security-event-hooks.md) §5.)
- **Don't** let prose run the full width of a panel.
- **Don't** leave a key alone on a row under the field it commits; give it a
  home (§ Keys have a home).
- **Don't** let a field, select or filter grow to the width of its panel
  (§ Fields have a measure).
- **Don't** make a phone scroll a long page to reach a panel the rail names.
- **Don't** clone Bitwarden's brand identity.
