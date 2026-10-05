/**
 * The gestures in force (ADR 0166): the catalogue's defaults with a person's
 * changes laid over them, read by the shell's recognizer, the `?` sheet and
 * Settings › Keybindings › Gestures, so none of them can disagree. It mirrors
 * `effective.ts`, one layer deep: a gesture has one target, not a sequence.
 */
import { NOP } from "./commands.js";
import type { KeymapConfig } from "./config.js";
import {
  GESTURES,
  type GestureBindings,
  type GestureId,
  gestureById,
  isGestureId,
} from "./gestures.js";
import { isMacroTarget, macroName, ownMacro } from "./macros.js";

/** Motion is on unless a person switched it off (WCAG 2.5.4). */
export function motionOn(config: KeymapConfig): boolean {
  return config.motion !== false;
}

export function defaultGestures(): Map<GestureId, string> {
  return new Map(GESTURES.map((gesture) => [gesture.id, gesture.default]));
}

/** The gestures a person changed; an absent layer reads as none. */
export function gestureLayer(config: KeymapConfig): Readonly<GestureBindings> {
  return config.gestures ?? {};
}

/**
 * Gesture → target as the shell runs it: `nop` strikes one, a macro that is
 * gone strikes it too, and a shake is inert while motion is switched off.
 */
export function effectiveGestures(
  config: KeymapConfig,
): Map<GestureId, string> {
  const map = defaultGestures();
  for (const [id, target] of Object.entries(gestureLayer(config))) {
    if (!isGestureId(id)) continue;
    const lost =
      isMacroTarget(target) &&
      ownMacro(config.macros, macroName(target)) === undefined;
    if (target === NOP || lost) map.delete(id);
    else map.set(id, target);
  }
  if (!motionOn(config)) {
    for (const gesture of GESTURES) {
      if (gesture.family === "motion") map.delete(gesture.id);
    }
  }
  return map;
}

export type GestureSource = "default" | "user" | "removed";

export type GestureRow = Readonly<{
  id: GestureId;
  label: string;
  family: string;
  /** What it runs now, or null when it is struck or its macro is gone. */
  target: string | null;
  source: GestureSource;
  /** What the catalogue ships on it, for the reset key's label. */
  defaultTarget: string;
  changed: boolean;
  /** Motion is off: a shake is drawn, and inert. */
  off: boolean;
}>;

/** One row per gesture: what it runs, where that came from. */
export function gestureRows(config: KeymapConfig): GestureRow[] {
  const layer = gestureLayer(config);
  const live = effectiveGestures(config);
  const motion = motionOn(config);
  return GESTURES.map((gesture) => {
    const own = layer[gesture.id];
    const source: GestureSource =
      own === undefined ? "default" : own === NOP ? "removed" : "user";
    return {
      id: gesture.id,
      label: gesture.label,
      family: gesture.family,
      target: live.get(gesture.id) ?? null,
      source,
      defaultTarget: gesture.default,
      changed: own !== undefined,
      off: !motion && gesture.family === "motion",
    };
  });
}

/** Put `target` on `id`, spelling the layer sparsely against the defaults. */
export function bindGesture(
  config: KeymapConfig,
  id: GestureId,
  target: string | null,
): KeymapConfig {
  const next: GestureBindings = { ...gestureLayer(config) };
  const shipped = gestureById(id)?.default;
  if (target === shipped) delete next[id];
  else next[id] = target === null ? NOP : target;
  return withGestures(config, next);
}

/** Forget what a person said about one gesture: its default returns. */
export function resetGesture(
  config: KeymapConfig,
  id: GestureId,
): KeymapConfig {
  const next: GestureBindings = { ...gestureLayer(config) };
  delete next[id];
  return withGestures(config, next);
}

/**
 * Every gesture bound to `from`, moved to `to` — or, with null, let go (a
 * renamed or deleted macro). A gesture that was never bound to it is left.
 */
export function retargetGestures(
  config: KeymapConfig,
  from: string,
  to: string | null,
): KeymapConfig {
  const next: GestureBindings = {};
  for (const [id, target] of Object.entries(gestureLayer(config))) {
    if (!isGestureId(id)) continue;
    if (target !== from) next[id] = target;
    else if (to !== null) next[id] = to;
  }
  return withGestures(config, next);
}

/**
 * The keymap with its keys and macros forgotten and its gestures kept — those
 * that do not name a macro, which goes with the rest. The Keyboard tab's reset
 * (ADR 0166): each loadout is reset on its own tab.
 */
export function keysForgotten(config: KeymapConfig): KeymapConfig {
  const kept: GestureBindings = {};
  for (const [id, target] of Object.entries(gestureLayer(config))) {
    if (isGestureId(id) && !isMacroTarget(target)) kept[id] = target;
  }
  const base: KeymapConfig = { bindings: {}, macros: {}, singleKeys: true };
  const motion = config.motion === false ? { motion: false } : {};
  return Object.keys(kept).length === 0
    ? { ...base, ...motion }
    : { ...base, ...motion, gestures: kept };
}

/** The keymap with its gestures and the motion switch forgotten, keys kept. */
export function gesturesForgotten(config: KeymapConfig): KeymapConfig {
  const { gestures: _gestures, motion: _motion, ...rest } = config;
  return rest;
}

function withGestures(
  config: KeymapConfig,
  gestures: GestureBindings,
): KeymapConfig {
  const { gestures: _was, ...rest } = config;
  return Object.keys(gestures).length === 0 ? rest : { ...rest, gestures };
}
