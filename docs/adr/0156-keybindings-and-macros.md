# ADR 0156 — Keybindings are their own settings, and every key is a person's

- Status: Accepted
- Date: 2026-09-28
- Amended by: [ADR 0170](0170-gesture-loadout.md) (the keymap is the keyboard's
  half of one keymap, not the whole of it)
- Builds on: [ADR 0064](0064-vault-vfs-keyboard-first.md) (the keyboard-first
  VFS and its vim motions), [ADR 0134](0134-item-type-marketplaces-and-settings-files.md)
  (Settings is files), [ADR 0149](0149-nothing-stored-in-the-clear.md) (what
  the client stores is sealed)
- Research: [Keybinding customization](../research/keybinding-customization.md)

## Context

The keymap was a panel at the foot of Settings › General: a textarea of YAML
(`settings/keybindings.yaml`) that could remap five of the shell's commands
and nothing else. Every motion, verb and `g` jump lived in a hard-coded
tinykeys table beside a small overlay of person-editable keys, so the two
disagreed about which keys existed. There was no way to see what a key did,
bind a sequence, unbind a default, find a conflict before it happened, or
make a key do more than one thing. Power users of vim, editors and games
expect all of that. Their tools share a small set of habits: capture a key
by pressing it, show keycaps, never overwrite silently, and keep a text file
that round-trips with the table.

## Decision

1. **Keybindings is a Settings category of its own** (`/settings/keybindings`,
   between General and Security), with two panels, Keymap and Macros, and one
   file, `settings/keybindings/config.yaml`. General keeps Appearance and
   Locking. An old `#settings-keybindings` link lands on the new tab.
2. **One command catalogue** (`packages/app-core/src/lib/keymap/commands.ts`)
   names every command the shell runs, with its default keys and its kind.
   The shell's handler (`apps/pages/src/lib/keymap.ts`) resolves every press
   through the *effective* keymap: the defaults with a person's changes laid
   over them, read as a sequence trie. So the handler, the `?` sheet and the
   Settings table cannot disagree. Counts (`5j`), sequences (`g v`,
   `Space f`) and vim's `timeoutlen` (a key that is both a binding and a
   prefix waits for the timeout) work for every binding, not only `g`.
3. **A person's keymap is sparse.** It holds only what they changed: a
   sequence bound to a command or a macro, or to `nop` (vim's `<Nop>`, VS
   Code's `-command`) to strike a default. It is stored under
   `opensesame.keymap.v2` through the sealed local port. The v1 flat map,
   which copied every default, migrates once to its differences. A write the
   device refuses is reported to the person and leaves the live keymap as it
   was, and a change made in another tab is taken up when this one regains
   focus (`refreshKeymap`, which emits only on a real difference). The file
   spells the same values, with every key that YAML could read as something
   else (`0`, `on`, `true`) written in quotes:

   ```yaml
   singleKeys: true
   keybindings:
     w: listing.next
     x: nop
     "Space t": macro.triage
   macros:
     triage:
       on: unlock
       steps: [listing.search, "3 listing.next"]
   ```

   Reset all reports a refused reset and leaves storage unchanged.

4. **Macros are named step lists.** Each step is a command and a count, and a
   macro is bound like any command. A count typed before its key repeats it
   (`3 Space t`). The Macros panel builds steps by picking or by *recording*:
   the presses are read exactly as the shell would read them, counts and
   sequences included.
5. **Event triggers** are vim's autocmd over a closed set: `on: unlock` (once
   per unlock, and again after a lock and the next unlock) and
   `on: enter:<section>` (each time the section segment of the path changes to
   that section, not for each path inside it). A trigger waits for the
   arrival's own focus to land. It stands down while a person is typing or a
   dialog is open, so it never takes focus from someone using the page; an
   unlock trigger that finds a field or dialog holding the keyboard tries
   again every 500 ms, up to 20 times, and then lets go. A trigger's motions
   act on the vault listing only, never the rail, and never dive or climb.
   An event that fires while a trigger is running is dropped, and events are
   rate-capped (3 per event per second, 20 in all per minute), so no macro can
   set another off in a loop.

6. **A key may hold in one listing only.** The keymap is *everywhere*; a
   **context** lays a person's own keys over it while the keyboard is in
   one listing. The set is closed, with no expression language (VS Code's
   `when`, vim's modes, Steam's action sets, without the grammar): `vault`,
   the vault listing, and `rail`, the rail tree, exactly what the handler's
   `listingOf(event)` reads from where the press landed. A context binding
   overrides the global effective binding for that sequence only while the
   keyboard is there, and `nop` in a context strikes a key only there:

   ```yaml
   keybindings:
     w: listing.next
   contexts:
     vault:
       d: item.edit
       j: nop
     rail:
       w: listing.first
   ```

   A context is sparse against the global keymap, as the global one is
   against the defaults, and stores under the same `opensesame.keymap.v2`
   (a missing `contexts` reads as none, and the v1 migration is untouched).
   Every guardrail below holds inside a context. The handler keeps one map
   per context and resolves a press, its pending prefix and the timeout that
   runs the shorter key, through the map of the listing the press landed in.

7. **A binding for a command this plan does not have is listed, not lost.**
   A section jump whose capability left the plan is kept in the file, so it
   returns with the capability. The Keymap panel draws each one (everywhere
   or in a context) in an **Unavailable** group after the commands, as its
   keycap and target id, with a status mark and a remove key.
8. **The half-typed keys are shown** (vim's `showcmd`, then which-key). The
   handler publishes a count, a sequence prefix, a register key waiting for its
   letter and a recording in progress to a tiny store
   (`apps/pages/src/lib/keymap-pending.ts`) after every press, and clears it
   on the timeout, on a fired command and on every stand-down guard. The
   workspace statusline draws a segment of its one row from it, only while
   something is pending: the keys as small caps (`3`, `g`, `recording @a`)
   and, on a wide screen, the continuations of the prefix read from the
   effective keymap of the listing it was typed in and labelled from the command catalogue
   (`g · v Vault · s Settings`). Under `(pointer: coarse), (max-width: 900px)`
   the list is not drawn and only the caps and the recording mark remain, so
   the row keeps its one line under DESIGN.md § Touch. A live region announces
   a recording starting or stopping, never each key.
9. **Registers record live** (vim's `q{a–z}` and `@{a–z}`). `q` and `@` are
   catalogue commands (`register.record`, `register.replay`, group Macros),
   rebindable like any other; each takes the next key as a letter. `q a`
   starts recording into register `a`, every command the keys then run is
   appended with its count (`j j j` folds to `3 listing.next`), and `q`
   stops and keeps it as the macro `q-a`, replacing an older recording of that
   register; an empty recording keeps nothing. Commands that ask before they
   act still run while recording, but are left out, so a replay cannot trash
   or share. `@a` replays `q-a` through the same `runMacro` a bound macro
   uses (`3@a` repeats, within the macro limits), `@@` replays the last one,
   and any other key after `q` or `@` cancels quietly. A key held down does
   not repeat `q`, `@`, its letter or a sequence key (a motion such as `j`
   still repeats), and a command that throws is not recorded. `register.*` is refused
   as a macro step and never runs from an event trigger. Because a recording
   is an ordinary macro it shows in the Macros panel and can be bound.
   A recording that storage refuses is announced as not kept and stays for a retry.

### Guardrails

- **Fixed keys.** Tab and Shift+Tab, Enter, Shift+Enter, Escape, F6, Shift+F10
  and the Menu key, and the count digits 1–9 keep the keyboard-only road
  open, so none of them can be bound. Alt with a letter, digit or named key,
  and Meta, never reach the keymap; a printable symbol made with Alt, Option
  or AltGr (`@` on a German layout) is that symbol and binds as one. The
  browser's own tab, window and
  reload keys are refused too (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp/Down,
  Ctrl+1–9, Ctrl+N/W/T, Ctrl+Shift+T/W/N, Ctrl+Q, Ctrl+R, F5, F11, F12).
- **A command that asks before it acts** (`item.trash`, `item.share`) is
  locked. No key may be moved onto it, so a remap cannot turn a key that
  used to move the cursor into a share. No macro may run it. Its own key
  may still be given to something else.
- **An event runs navigation only.** A macro with `on:` may name `navigate`
  commands and nothing that reveals, drafts, mutates or opens the
  microphone. One run on entering a section may not jump to another
  section. Beyond what a macro may name, the handler enforces it at run time
  (vault-list motions only, no re-entrancy, the rate caps in §5), so
  triggers cannot loop.
- **One press is bounded.** Sequences are at most four presses, and a macro
  is at most 32 steps of at most 99 each. One press runs at most 1,000
  commands however large the count in front of it; a counted command is
  charged its count against that budget.
- **Nothing is overwritten quietly.** Recording a key that is already taken
  names the command that holds it and offers three choices: swap (the
  holder takes the replaced key, as a game's binding screen offers), take
  (the holder loses the key), or keep things as they were. A command that
  asks before it acts is never offered a swap.
- **Character keys can be switched off** (WCAG 2.1.4 Character Key
  Shortcuts). With `singleKeys: false`, any sequence that starts with a
  printed character is inert. Control combinations, arrows and named keys
  still work.
- **A keymap from the panel or the file is refused whole or kept whole.** It
  never names a URL, and a macro is found by its own name only: a binding to
  `macro.constructor` or any other object member is refused as a missing
  macro. A keymap already in storage is judged entry by entry when it loads,
  so a command id retired since it was saved costs the person that one
  binding, not their whole keymap; the next save writes back what survived.
- **Every guardrail holds per context.** A context refuses reserved keys, an
  unknown context name, a URL, a macro that does not exist and a locked
  command that was not already on that key; `singleKeys: false` silences
  character keys in a context too. A context binding cannot reach a listing
  the keymap does not name.

## Consequences

- The Keymap panel lists every command with its keycaps. A struck default
  stays drawn, dashed and struck through, and pressing it restores the key.
  A key the person added carries the accent on its lower edge. A changed row
  carries an editor's gutter mark and a reset key. A key that shares a
  prefix is marked, because it waits. Commands can be found by name or by
  pressing the keys (VS Code's Record Keys). The editor loads as its own
  chunk on a Keybindings visit.
- `KEYMAP_HELP_CORE` still describes the defaults, and the `?` sheet reads
  that way while nothing is rebound. Once a person moves or strikes a key, the
  sheet is drawn from the effective bindings: a row whose commands changed is
  rebuilt one line per command, a key moved onto another command is on that
  command, a row whose commands lost every key is dropped, and only keys for
  commands the sheet has no row for (and context-scoped keys) follow.
- `j` and `gg` now bring the keyboard to the listing they move, exactly as
  `k` and `G` always did. The overlay that ran them used to skip that step.
- The Keymap panel head has a scope choice beside the view filter:
  *everywhere*, *in the vault list*, *in the rail*. The table then shows each
  command's keys as they hold in that scope: global keys, context keys (a
  keycap washed with the accent, its scope in the title and label), and keys
  struck there. Recording, conflicts, swap, remove, restore, per-row reset,
  and the changed filter and gutter mark all act on the chosen scope; the
  conflict check reads that scope's effective map, so a key held only in the
  vault list is free in the rail. *Everywhere* behaves as before.
- The keymap is read again on `storage` and on `focus`, so a change made in
  another tab is live here without a reload (`refreshKeymap`, which redraws
  only on a real difference and never empties a keymap it cannot read back).
- The statusline gains a segment while keys are half-typed. It is a part of
  the row, never a layer over it, and it is absent (costs no gap) otherwise.
- A recorded register is a macro named `q-<letter>`, so the
  file view and the Macros panel show it, and deleting the macro clears the
  register.
