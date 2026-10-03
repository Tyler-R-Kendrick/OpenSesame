# Keybindings review fixes: the `?` sheet and the Fixed keys

Two visible changes in the stacked review fixes for #574 (#628 to #631).
The other fixes (storage refusals, recorder, macro editor, key capture
announcements) show only in rare error states; the pull requests name the tests
that cover them.

Two real builds walked the same journey (`journey.json`): the base is `main` at
`fb7a0273`, the branch is this stack. Each build opens as a guest, moves `j` to
`w` for Next row in Settings › Keybindings, then presses `?`, and reads the
Fixed group.

| Sheet | Shows |
|---|---|
| [`1280-help-sheet.png`](1280-help-sheet.png) | The `?` sheet after the move. Before, "j / k or arrows — Move" stays and `j` is listed again as "unbound" with `w` as an extra row. After, "↓ / w — Next row" and "k / ↑ / Ctrl-p — Previous row"; the sheet matches the keymap in force. |
| [`1280-fixed-keys.png`](1280-fixed-keys.png) | The read-only Fixed group, desktop. After, it names the Menu key. |
| [`390-fixed-keys.png`](390-fixed-keys.png) | The same group on a phone. |

## Measurements (from the browser)

- Before: the `?` sheet draws 20 rows after the move, including a row for `j`
  that says "unbound" and a second "Next row (yours)" row for `w`.
- After: the sheet draws 19 rows (counted on the sheet); the moved key replaces its default in the
  Move rows and no row says "unbound".
- Fixed group: before `Shift+F10 / Shift+Enter`, after
  `Shift+F10 / Shift+Enter / Menu`. `ContextMenu` is reserved and could not be
  bound before; it is now disclosed.
