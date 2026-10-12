# Keybinding, hotkey and macro customization

> Status (2026-10-08): [ADR 0156](../adr/0156-keybindings-and-macros.md)
> landed. Settings › Keybindings
> (`apps/pages/src/sections/settings/keybindings/`) draws one command
> catalogue (`packages/app-core/src/lib/keymap/commands.ts`), and the shell's
> handler (`apps/pages/src/lib/keymap.ts`) resolves every press through the
> effective keymap. The survey below is as of 2026-09-28; where it and the ADR
> differ, the ADR wins.

How products with passionate power users let people rebind keys, compose
sequences and record macros — and what a keyboard-first, vim-flavoured,
terminal-styled settings page should take from them. Fed
[ADR 0156](../adr/0156-keybindings-and-macros.md) (Settings › Keybindings) over
`apps/pages/src/lib/keymap.ts` (the `g` chord, its 1000 ms `goTimeoutMs`,
counts) and [ADR 0064](../adr/0064-vault-vfs-keyboard-first.md). Surveyed 2026-09-28;
details marked *(unverified)* come from memory of the product, not a page
fetched for this note.

## 1. Editors

**VS Code** — the reference design for a searchable binding table.
- The Keyboard Shortcuts editor (`Ctrl+K Ctrl+S`) is one filterable table:
  command, keybinding, `when`, source. Typing filters by command name *or*
  by key text ([docs](https://code.visualstudio.com/docs/configure/keybindings)).
- **Record Keys** (`Alt+K`, `⌥⌘K` on macOS) turns the search box into a
  keystroke recorder: press the keys, see every command bound to them; Esc
  leaves the mode. Shipped in [1.28](https://code.visualstudio.com/updates/v1_28).
  Getting stuck in it is a filed bug ([#82714](https://github.com/microsoft/vscode/issues/82714)) —
  capture modes need an obvious exit.
- Source column (Default / User / Extension) with filters such as
  `@source:user` ("Show User Keybindings"). Right-click → **Show Same
  Keybindings** lists every entry on that chord — conflict listing on demand.
- `when` clauses scope a binding (`==`, `!=`, `&&`, `||`, `=~`); no clause means
  global. Chords are space-separated (`ctrl+k ctrl+c`).
- `keybindings.json` is the round-trippable text form; a default is removed
  with a `-command` entry (`{ "key": "tab", "command": "-jumpToNextSnippetPlaceholder" }`)
  rather than by editing defaults. `Ctrl+K Ctrl+K` in the JSON opens a
  *Define Keybinding* capture widget that writes the serialized key.
- **Developer: Toggle Keyboard Shortcuts Troubleshooting** logs what each
  keypress resolved to — the "why did that fire?" tool.

**JetBrains IDEs** ([keymap docs](https://www.jetbrains.com/help/idea/configuring-keyboard-and-mouse-shortcuts.html)).
- Settings › Keymap: a tree of actions grouped by area, a name filter, and a
  **Find Action by Shortcut** icon that opens a capture dialog.
- Per action: *Add Keyboard Shortcut* (with a **Second stroke** checkbox for
  two-step chords), *Add Mouse Shortcut* (click/scroll + modifiers),
  *Add Abbreviation* (a word for Find Action), *Reset Shortcuts*.
- Predefined keymaps are immutable; the first edit forks a copy — defaults
  are never lost. Presets exist per OS and per rival editor.
- Assigning a used shortcut warns and offers to take it (*Remove* the other
  assignments) or keep both (*Leave*) *(button labels unverified)*. Remaining
  conflicts are listed in the keymap ([troubleshooting](https://www.jetbrains.com/help/idea/keyboard-shortcuts-troubleshooting.html)).
- **Edit › Macros › Start Macro Recording**, then save by name; a macro is an
  action and can itself be bound *(unverified path)*.

**Zed** ([key-bindings](https://zed.dev/docs/key-bindings)).
- JSON keymap of blocks, each with a `context` expression (`X && Y`, `!X`,
  `X > Y` = ancestor/child). `null` as the action unbinds in that context.
- A keymap editor (`Cmd-K Cmd-S`) lists every action with its default binding;
  edit via pencil, double-click, or Enter.
- On a prefix of a longer sequence Zed waits one second and shows a
  **countdown in the status bar** with the pending keys; hovering pauses it.
- Base keymaps (VS Code, JetBrains, Sublime, Emacs…) as a starting point.

**Vim / Neovim** ([map.txt](https://vimhelp.org/map.txt.html), [repeat](https://neovim.io/doc/user/repeat.html)).
- Mappings are per mode: `:nmap :xmap :omap :imap :cmap :tmap`…
- `:map` rescans the right-hand side for mappings (recursive); `:noremap`
  does not. Safe default: non-recursive.
- Ambiguous prefixes resolve by `timeout`/`timeoutlen` (default 1000 ms).
- `<Leader>` is a user-chosen namespace key (default `\`).
- Macros: `q{reg}` … `q` records keystrokes into a register; uppercase
  appends; `[count]@{reg}` replays, `@@` repeats. Because a macro is text in
  a register it can be pasted, edited and yanked back — the edit loop for
  free.
- `autocmd {event} {pattern} {cmd}` binds behaviour to events
  (`BufEnter`, `InsertLeave`, `VimEnter`…), not to keys.

**which-key.nvim** ([repo](https://github.com/folke/which-key.nvim)) — after a
prefix, a popup lists the possible next keys and their descriptions
(default delay ~200 ms). Discovery at the moment of need; it also groups
`<leader>` subtrees with names.

**Emacs** — prefix keys (`C-x`, `C-c`) are keymaps of their own; pressing
`C-h` after a prefix lists what it contains; `C-h k` (**describe-key**)
answers "what does this key do and where was it bound" *(from the manual;
page unavailable at fetch time)*.

**Helix** ([remapping](https://docs.helix-editor.com/remapping.html)) — keymap
is `config.toml` only: `[keys.normal]`, nested tables for minor modes
(`[keys.normal.g]`), an array for a command sequence
(`ret = ["open_below", "normal_mode"]`), `@` for a key macro, `no_op` to
unbind. Config as the whole UI.

## 2. Games

**World of Warcraft** — Options › Keybindings: categories (movement, action
bars, targeting…), **two binding columns per action** (primary + secondary),
and a **Character Specific Key Bindings** checkbox that switches scope
account-wide ↔ this character ([wiki](https://warcraft.wiki.gg/wiki/Key_Bindings)).
Binding a used key moves it and names what was unbound *(unverified wording)*.
The macro UI is a per-account/per-character list of named text macros
(`/cast`, `/use`, conditionals like `[mod:shift]`), each draggable to an
action slot — macros are just another bindable action.

**StarCraft II / RTS** — hotkey *profiles* (Standard, Grid, custom) as
named, shareable files. Grid maps the 3×5 command card onto the left hand
by position rather than mnemonic. Conflicting commands turn **red**, and the
red propagates up to the unit and the race that contain the conflict
([hotkey editor README](https://github.com/jcfieldsdev/starcraft2-hotkey-editor/blob/master/README.md),
[Liquipedia](https://liquipedia.net/starcraft2/Hotkeys)).

**Factorio / Minecraft / Valorant / CS2 / Elden Ring** — the common
"controls" list: click a slot → "press a key" → the next key is taken, Esc
cancels (or, in some titles, unbinds — an inconsistency to avoid);
**primary + alternate** columns; reset per row and **Reset all**; per-context
maps (on foot / vehicle / menu, Elden Ring's separate menu map). Conflict
policy varies: Minecraft shows conflicting keys in red and lets them stand
*(unverified)*; many shooters steal the key and leave the other action
unbound; Factorio deliberately allows duplicates because some pairs are fine
together, and right-click clears a binding ([forum](https://forums.factorio.com/47514)).
The lesson: a conflict only matters where contexts overlap.

**Blender** ([keymap](https://docs.blender.org/manual/en/4.2/editors/preferences/keymap.html)) —
a context tree (Window, Screen, 3D View › Object Mode…), a search that
switches between **Name** and **Key-Binding**, restore per item and per
keymap, export/import as a file, and an **Industry Compatible** preset for
people arriving from Maya/other DCCs.

**Steam Input** ([action sets](https://partner.steamgames.com/doc/features/steam_controller/getting_started_for_devs),
[activators](https://partner.steamgames.com/doc/features/steam_controller/activators)) —
*action sets* are contexts ("in a vehicle, or on foot, or navigating the
menu"); *action set layers* overlay a parent and inherit what they do not
override. One input can carry several **activators**: Regular, Long Press,
Double Press, Start Press, Release Press, Chorded Press (another button
held), each with Toggle, Turbo, Fire Start/End Delay, Cycle. A binding can
emit several commands — macros as a list with delays.

**Logitech G Hub / Razer Synapse** — record keystrokes (and mouse) into a
step list, with or without the recorded delays (fixed default delay
instead); then edit steps, insert delays, and choose a play mode: once,
repeat while held, toggle, or a press/hold/release sequence
([overview](https://mousepresets.com/how-to-set-up-macros-and-lua-scripts-in-logitech-g-hub/)).

## 3. Productivity apps

- **GitHub** — `?` opens the page's shortcut sheet; `g c`, `g i`, `g p`
  sequences; single-character shortcuts can be switched off in
  accessibility settings while modifier shortcuts remain
  ([docs](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)) —
  WCAG 2.1.4 in practice.
- **Linear** — single letters plus `G then X` navigation, `?` for the full
  list ([cheat sheet](https://shortcut.fyi/linear-shortcuts)). Not rebindable
  *(unverified)*.
- **Superhuman** — every command is in `Cmd+K`, which shows each shortcut
  beside its command, so the palette teaches the keys; shortcuts are fixed
  ([help](https://help.superhuman.com/hc/en-us/articles/43658258433299-Desktop-Shortcuts)).
- **Raycast** — a hotkey *field* that records the next chord when focused,
  with a clear button, used for every command and extension; aliases as the
  typed alternative *(unverified detail)*.
- **Karabiner-Elements** — "complex modifications": JSON rules of
  manipulators, `from` → `to`, `to_if_alone` (tap vs hold), and `conditions`
  such as `frontmost_application_if`; importable rule sets
  ([docs](https://karabiner-elements.pqrs.org/docs/manual/configuration/add-your-own-complex-modifications/)).
- **Obsidian** — Settings › Hotkeys: filter by name or by hotkey, `+` next
  to a command captures a new chord, each binding is a chip with an `×`,
  several chips per command ([help](https://obsidian.md/help/hotkeys)).
  Conflicts are flagged inline, but users must scroll to find them and a
  filtered view can hide them — hence open requests for a "conflicting"
  filter and per-pane restore-defaults
  ([conflicts](https://forum.obsidian.md/t/search-hotkeys-quick-filter-for-conflicts/111651),
  [restore](https://forum.obsidian.md/t/hotkeys-restore-defaults/114066)).
  The hotkey filter is also reported as not operable by keyboard
  ([bug](https://forum.obsidian.md/t/cannot-trigger-or-reset-hotkeys-filter-bars-filter-by-hotkey-functionality-via-keyboard/117769)).

## 4. Principles worth emulating

1. **One table, every action, defaults visible.** Each row: action, context,
   bindings, source. The whole catalogue is listed even when unbound
   (VS Code, JetBrains, Zed, Blender). Defaults are shown, never hidden.
2. **Capture by pressing, in place.** Enter on a binding cell turns that cell
   into a recorder ("press keys…"); the next chord is taken and shown as a
   keycap. Enter/click-away confirms, Esc cancels — never unbinds (Raycast,
   Obsidian `+`, game control lists, JetBrains dialog without the dialog).
3. **Several bindings per action, as keycap chips.** Primary + alternates as
   removable chips with `×` and a `+` (WoW columns, Obsidian chips,
   JetBrains lists). A chip is `<kbd>` per key, sequences space-separated.
4. **Sequences are first-class, with a visible timeout.** Capture accepts
   `g i`-style multi-step keys: each step appends until a pause of
   `timeoutlen` (reuse `goTimeoutMs`) or Enter. Show pending keys and a
   countdown while waiting (Zed status bar, Vim `showcmd`, JetBrains second
   stroke), and a which-key panel of possible continuations.
5. **Search by name *or* by keystroke.** A filter field plus a Record Keys
   toggle that answers "what is on `g v`?" (VS Code `Alt+K`, JetBrains Find
   by Shortcut, Blender Key-Binding search, Emacs describe-key).
6. **Conflicts detected live, scoped by context, resolved explicitly.** A
   conflict is two bindings on the same keys in overlapping contexts only
   (Factorio's lesson). Show it inline on both rows (SC2 red propagation),
   offer a "conflicts" filter (VS Code Show Same Keybindings; what Obsidian
   users ask for), and at capture time offer **Replace** (take it, unbind the
   other, name it) / **Keep both** / **Cancel** — never a silent steal.
7. **Source and modified markers; reset per row and reset all.** Default /
   user / (future) imported, with a modified dot on changed rows, a "show
   modified only" filter, per-row reset and a confirmed reset-all (VS Code
   source, JetBrains fork-on-edit, games' Reset, Blender restore).
8. **Contexts/scopes as data.** Tree, list, prompt, sheet, text field,
   global — a binding carries its context (VS Code `when`, Zed `context`,
   Vim modes, Steam action sets/layers with inheritance). Keep the grammar
   small: a closed set of named contexts, not an expression language, until
   one is proven necessary.
9. **Macros as editable step lists.** A macro is a named, bindable action
   whose body is an ordered list of steps (command or keys), each with an
   optional repeat count and delay; the whole macro takes a `[count]` prefix
   (Vim `3@q`, G Hub step editor, Helix command arrays, WoW macros as
   actions). A **recorder** (`q{reg}`-style start/stop, visible "recording
   @q" in the statusline) fills the list; editing the list is the way to fix
   it — never "re-record from scratch".
10. **Event triggers alongside keys.** Allow a macro to run on a closed set
    of app events (unlock, lock, section enter, vault open) the way
    `autocmd` does — explicit, listed on the same page, off by default, and
    never able to reveal or export secrets.
11. **A text form that round-trips.** The table is a view of one file
    (JSON or a vimrc-like text) that can be viewed, edited, exported and
    imported, with removal of a default expressed as an entry (`-command`,
    `null`, `no_op`) rather than editing defaults — this matches ADR 0134 §4
    ("Settings is files; the Form is a view of them"). Presets
    (vim-default, "arrows only", "no single-letter keys") are just files.
12. **Reserved keys and guardrails.** Some keys cannot be captured or
    rebound: Tab/Shift-Tab (focus order), Esc's leave-field semantics, F6,
    the key that exits capture, browser/OS-reserved chords, and whatever
    keeps guest/unlock reachable. Reject with a reason at capture time. Offer
    a single switch for single-character shortcuts (GitHub, WCAG 2.1.4). A
    "why did that fire?" affordance (VS Code troubleshooting, describe-key)
    closes the loop.

Supporting details: persist through the at-rest-sealed settings store
(ADR 0149), not raw `localStorage`; show the effective bindings in the `?`
sheet and command bar so the palette teaches keys (Superhuman); and keep
every control of the editor itself keyboard-operable, since the page that
edits keys is the one power users will drive by keys.

## 5. Anti-patterns

- **Modal-only capture that traps focus** — a dialog that swallows every key
  including the ones needed to leave it (VS Code's stuck Recording Keys
  bug). Capture must be inline, visibly armed, and always escapable.
- **Capturing Tab or Esc with no escape hatch** — binding the navigation or
  cancel key itself strands keyboard users; reserve them.
- **Esc meaning "unbind"** in some games and "cancel" in others — pick
  cancel; unbinding is the chip's `×` or Delete.
- **Silent overwrite** — stealing a key from another action without naming
  it (common in shooters). Always say what lost the key and offer undo.
- **Hiding defaults / only showing overrides** — users cannot discover what
  exists or what they changed; also editing defaults in place so reset is
  impossible (JetBrains' fork-on-edit avoids this).
- **Global conflict warnings that ignore context** — nagging about bindings
  that can never fire together teaches users to ignore warnings (Factorio's
  reason for having none; the fix is scoping, not silence).
- **Conflicts discoverable only by scrolling**, or hidden by an active
  filter (Obsidian reports).
- **A filter or capture control operable only by mouse** (Obsidian's
  hotkey filter).
- **Recorder-only macros** — no step editor, no way to remove one wrong key
  or add a repeat count.
- **Unbounded macro timing and recursion** — recursive mappings
  (`:map` vs `:noremap`) and macros that call themselves; default to
  non-recursive, cap depth and repeat counts.
- **Opaque storage** — bindings that cannot be exported, diffed or shared,
  or a text form that does not round-trip with the UI.
- **Undiscoverable sequences** — `g`-chords with no pending indicator and no
  which-key/`?` sheet listing the next keys.
- **Letting a macro or event trigger do what a key cannot** — reveal,
  export or approve; automation must stay within the same authority as the
  keys it replays.
