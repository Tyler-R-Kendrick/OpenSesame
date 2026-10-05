/**
 * The gesture loadout (ADR 0168): the keymap's touch half. A keyboard binds
 * sequences to commands; a hand binds a short, closed set of gestures to the
 * same commands. Nothing here is a second authority model: a gesture runs
 * what a key could, through the same `runTarget`, under the same guardrails.
 *
 * The set is closed on purpose, like the contexts. One finger belongs to the
 * page — a tap activates, a drag scrolls, a hold or a row swiped left asks
 * for the row's actions, a pane swiped right goes back — and a pinch is the
 * browser's zoom. Those are fixed and cannot be bound, so a person can never
 * lose the touch road. What is left to bind is what a thumb cannot reach by
 * accident: two fingers, and the phone itself.
 */
import {
  type KeymapCommand,
  NOP,
  REGISTER_PREFIX,
  SECTION_PREFIX,
  commandById,
} from "./commands.js";
import { type Macro, isMacroTarget, macroName, ownMacro } from "./macros.js";

export type GestureFamily = "swipe" | "tap" | "motion";

export type GestureId =
  | "two-finger-swipe-left"
  | "two-finger-swipe-right"
  | "two-finger-swipe-up"
  | "two-finger-swipe-down"
  | "two-finger-tap"
  | "shake";

export type KeymapGesture = Readonly<{
  id: GestureId;
  label: string;
  family: GestureFamily;
  /** The command it runs until a person chooses another. */
  default: string;
}>;

/**
 * Every gesture a person may bind. The defaults read as the thumb would:
 * a two-finger swipe left goes in and right comes out (the way the one-finger
 * swipe back already goes), up is toward the end of the list and down toward
 * its top, a two-finger tap asks for the command bar, and a shake asks for
 * help. None of them is destructive, so a pocket cannot do harm.
 */
export const GESTURES: readonly KeymapGesture[] = [
  {
    id: "two-finger-swipe-left",
    label: "Two-finger swipe left",
    family: "swipe",
    default: "listing.dive",
  },
  {
    id: "two-finger-swipe-right",
    label: "Two-finger swipe right",
    family: "swipe",
    default: "listing.climb",
  },
  {
    id: "two-finger-swipe-up",
    label: "Two-finger swipe up",
    family: "swipe",
    default: "listing.last",
  },
  {
    id: "two-finger-swipe-down",
    label: "Two-finger swipe down",
    family: "swipe",
    default: "listing.first",
  },
  {
    id: "two-finger-tap",
    label: "Two-finger tap",
    family: "tap",
    default: "command.palette",
  },
  {
    id: "shake",
    label: "Shake the phone",
    family: "motion",
    default: "help.keymap",
  },
];

/** Gestures in the order a panel draws them. */
export const GESTURE_IDS: readonly GestureId[] = GESTURES.map(
  (gesture) => gesture.id,
);

export function isGestureId(value: string): value is GestureId {
  return GESTURES.some((gesture) => gesture.id === value);
}

export function gestureById(id: string): KeymapGesture | undefined {
  return GESTURES.find((gesture) => gesture.id === id);
}

/** Gesture → target, sparse: only what a person changed. `nop` strikes one. */
export type GestureBindings = Partial<Record<GestureId, string>>;

/**
 * The gestures that keep the touch road open, as a panel lists them under its
 * lock. Each is the twin of something that already exists (DESIGN.md § Touch).
 */
export const FIXED_GESTURES: readonly (readonly [
  gesture: string,
  label: string,
])[] = [
  ["Tap", "Open or activate"],
  ["Hold, or swipe a row left", "Actions for the row"],
  ["Swipe a pane right", "Back"],
  ["Pinch", "Zoom, the browser's"],
];

/** Names a file may write for a gesture it cannot rebind, and why. */
const RESERVED_GESTURES: ReadonlyMap<string, string> = new Map([
  ["tap", "Open or activate"],
  ["long-press", "Actions for the row"],
  ["swipe-left", "Actions for the row"],
  ["swipe-right", "Back"],
  ["pinch", "Zoom, the browser's"],
  ["scroll", "The browser's"],
]);

/** Why `name` is not a gesture a keymap may bind, or null when it is. */
export function gestureNameProblem(name: string): string | null {
  if (isGestureId(name)) return null;
  const reason = RESERVED_GESTURES.get(name);
  if (reason !== undefined) return `${name} is fixed: ${reason}.`;
  return `"${name}" is not a gesture.`;
}

const UNSAFE_TARGET = /^(https?:|javascript:|data:|\/\/)|:\/\//i;

/**
 * Why `target` may not be bound to a gesture, or null. A gesture is a single
 * touch with no way to ask, so a command that asks before it acts is refused
 * outright (no gesture ships bound to one), and a register key, which waits
 * for a letter a hand cannot give, is refused too.
 */
export function gestureBindingProblem(
  target: string,
  commands: readonly KeymapCommand[],
  macros: Readonly<Record<string, Macro>>,
): string | null {
  if (UNSAFE_TARGET.test(target))
    return "Keybindings cannot name URLs or endpoints.";
  if (target === NOP) return null;
  if (isMacroTarget(target)) {
    return ownMacro(macros, macroName(target)) === undefined
      ? `No macro "${macroName(target)}".`
      : null;
  }
  if (target.startsWith(REGISTER_PREFIX))
    return `${target} waits for a letter: a gesture cannot give one.`;
  const command = commandById(target, commands);
  if (command === undefined && !target.startsWith(SECTION_PREFIX))
    return `Unknown action "${target}".`;
  if (command?.kind === "authority")
    return `Action "${target}" requires confirmation and cannot be bound to a gesture.`;
  return null;
}

/**
 * Which half of the keymap a device leads with: a finger first, the gestures;
 * anything else, the keys. The same query the `?` sheet already reads
 * (`(pointer: coarse)`), so the sheet, the Settings tab and the help row never
 * disagree about what this device is. Keys still work on a phone with a
 * keyboard attached, and gestures on a laptop with a touch screen.
 */
export type Loadout = "keyboard" | "gestures";

export const LOADOUTS: readonly { id: Loadout; label: string }[] = [
  { id: "keyboard", label: "Keyboard" },
  { id: "gestures", label: "Gestures" },
];

export function preferredLoadout(touch: boolean): Loadout {
  return touch ? "gestures" : "keyboard";
}

/**
 * A command's label as a gesture says it. A count has no gesture, so "Last row,
 * or row N" is "Last row" under a finger.
 */
export function gestureActionLabel(label: string): string {
  return label.replace(/, or row N$/, "");
}
