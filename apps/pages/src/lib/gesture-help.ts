import { keymapCommands } from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import { targetLabel } from "@opensesame/app-core/lib/keymap/effective.js";
import { effectiveGestures } from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import {
  GESTURES,
  gestureActionLabel,
} from "@opensesame/app-core/lib/keymap/gestures.js";

export type GestureHelpRow = readonly [gesture: string, action: string];

/**
 * What a finger does that the keymap does not decide: the fixed gestures, and
 * the keys drawn on the screen. A phone has no `j`, no `Ctrl-d` and no `?`, so
 * its commands are taps, holds and swipes, and the keymap sheet is this list
 * there. Every row names a gesture the shell really recognises
 * (`lib/gestures.ts`, the context menu's input) — a row with no recogniser
 * behind it would promise what nothing does.
 */
export const GESTURE_HELP: readonly GestureHelpRow[] = [
  ["Tap a row", "Open it"],
  ["Hold a row", "Its actions"],
  ["Swipe a row left", "Its actions"],
  ["Swipe right", "Back"],
  ["Tap the + key", "New item"],
  ["Tap the search key", "Search the list"],
];

/** What the sheet needs to know of the device beyond the keymap. */
export type GestureView = Readonly<{
  config: KeymapConfig;
  /** The phone has a motion sensor: a shake can be offered at all. */
  motion: boolean;
}>;

/**
 * The sheet a finger reads (ADR 0165): the fixed gestures, then the gestures
 * in force, each with what it runs now. A gesture a person struck is not
 * listed, and neither is a shake the phone cannot make.
 */
export function gestureHelpRows(view?: GestureView): readonly GestureHelpRow[] {
  if (view === undefined) return GESTURE_HELP;
  const commands = keymapCommands();
  const live = effectiveGestures(view.config);
  const own = GESTURES.flatMap((gesture): GestureHelpRow[] => {
    const target = live.get(gesture.id);
    if (target === undefined) return [];
    if (gesture.family === "motion" && !view.motion) return [];
    return [[gesture.label, gestureActionLabel(targetLabel(target, commands))]];
  });
  return [...GESTURE_HELP, ...own];
}
