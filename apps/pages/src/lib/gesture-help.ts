/**
 * What a finger does where the keyboard does something else.
 *
 * A phone has no `j`, no `Ctrl-d` and no `?`: its commands are taps, holds and
 * swipes, and the keymap sheet becomes this list there. Every row names a
 * gesture the shell really recognises (`lib/gestures.ts`, the context menu's
 * input) — a row with no recogniser behind it would promise what nothing does.
 */
export const GESTURE_HELP: readonly (readonly [
  gesture: string,
  action: string,
])[] = [
  ["Tap a row", "Open it"],
  ["Hold a row", "Its actions"],
  ["Swipe a row left", "Its actions"],
  ["Swipe right", "Back"],
  ["Tap the + key", "Add an item"],
  ["Tap the search key", "Search the vault"],
];
