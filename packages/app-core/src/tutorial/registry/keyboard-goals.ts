/**
 * Tutorials for the keyboard (ADR 0156, ADR 0163 §6): moving through a
 * listing, the three keys that reach the shell from anywhere, and macros.
 *
 * A key is taught in the words a person would read it in, and
 * `keymap-tutorials.ts` names the sentence each key is said in, so a rewrite
 * that drops a key from its tour fails a test instead of going unnoticed. The
 * tours say what the default keys do; Settings → Keybindings lists every key
 * and is where a person changes one.
 *
 * Every string is a checked-in literal: nothing here names an item.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const KEYBOARD_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.keys.move",
    title: "Move through the list from the keyboard",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vault.keys.move"',
      'say "A listing is anything drawn as rows: the vault list and the tree of sections. One row holds the cursor, and these keys move it. F6 moves the keyboard to the other listing."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.list" "j or the down arrow moves to the next row; k or the up arrow, to the previous. A count in front repeats a key: 3j moves three rows down. Moving over an item previews it in the pane beside the list." side=right',
      'say "gg, Home or 0 goes to the first row; G, End or $ to the last. With a count, 5G goes to row 5."',
      'say "H, M and L go to the top, middle and bottom row of what is on screen."',
      'say "Ctrl-d and Ctrl-u move half a page down and up. Ctrl-f and Ctrl-b, or Page Down and Page Up, move a whole page."',
      'say "l or the right arrow dives in: it opens a folder, or the item itself. h, the left arrow or Backspace climbs out: it closes a folder, or steps up to the folder holding the row, and from the top level it hands the keyboard to the tree of sections."',
      'success "A count in front repeats most of these keys. Settings → Keybindings lists every key and lets you change it."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.keys.bar",
    title: "The command bar, key help and voice",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vault.keys.bar"',
      'say "Three keys reach the shell from anywhere in the vault: one for the command bar, one for the key help, and one for your voice."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.command-bar" "Press : or Ctrl-l and the cursor jumps here. Type a command: go to a section, search, or copy a field. Enter runs it." side=bottom',
      'say "Press ? and the keyboard help opens: every key now in force, so a key you moved shows where it went."',
      'say "Press m to speak. It listens while the command bar draws a microphone, which needs the On-device model switched on under Settings → Capabilities and a browser that can hear you; press m again to run what was heard. With no microphone, the key does nothing."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.keys.macros",
    title: "Record and replay a macro",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vault.keys.macros"',
      'say "A macro is a run of keys kept under a letter, as in vim. Press q and then a letter, a through z, to start recording into that register."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.list" "Now use the list as usual: 3j, gg, l. Every command is recorded with its count. Press q again to stop and keep the recording. The statusline marks it while it runs." side=right',
      'say "@ and the letter replays it: @a plays register a, 3@a plays it three times, and @@ plays the last one again."',
      'say "Trash, share and delete are left out of a recording, so a replay can never run them."',
      'success "A recording is an ordinary macro named q- and its letter. It is listed under Macros in Settings → Keybindings, where it can be given a key of its own."',
      "end",
    ].join("\n"),
  },
];
