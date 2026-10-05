/**
 * View-model for Settings › Keybindings › Gestures (ADR 0167): what a gesture
 * may be bound to, as the choices its row offers. No React, no DOM.
 */
import {
  GROUP_LABEL,
  GROUP_ORDER,
  type KeymapCommand,
  MACRO_PREFIX,
  REGISTER_PREFIX,
} from "../../lib/keymap/commands.js";
import type { KeymapConfig } from "../../lib/keymap/config.js";
import {
  gestureActionLabel,
  gestureBindingProblem,
} from "../../lib/keymap/gestures.js";

export type TargetOption = Readonly<{ id: string; label: string }>;

export type TargetGroup = Readonly<{
  id: string;
  label: string;
  options: readonly TargetOption[];
}>;

/** The row's "no action" choice: a gesture struck, or its macro gone. */
export const NO_ACTION = "";

/**
 * Every command a gesture may run, grouped as the Keymap table groups them,
 * then the person's macros. A command that asks before it acts, a register key
 * and a command that is not on this plan are not offered at all.
 */
export function targetGroups(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
): TargetGroup[] {
  const allowed = (command: KeymapCommand) =>
    command.kind !== "nop" &&
    !command.id.startsWith(REGISTER_PREFIX) &&
    gestureBindingProblem(command.id, commands, config.macros) === null;
  const groups: TargetGroup[] = GROUP_ORDER.map((group) => ({
    id: group,
    label: GROUP_LABEL[group],
    options: commands
      .filter((command) => command.group === group && allowed(command))
      .map((command) => ({
        id: command.id,
        label: gestureActionLabel(command.label),
      })),
  }));
  const macros = Object.keys(config.macros)
    .sort()
    .map((name) => ({ id: `${MACRO_PREFIX}${name}`, label: `@${name}` }));
  return [
    ...groups,
    { id: "macros-yours", label: "Your macros", options: macros },
  ].filter((group) => group.options.length > 0);
}

/** Whether `target` is one of the choices: the plan has it, and a gesture may run it. */
export function isOffered(
  target: string,
  groups: readonly TargetGroup[],
): boolean {
  return groups.some((group) =>
    group.options.some((option) => option.id === target),
  );
}

/**
 * A row's choices. A target this plan does not have (a section whose capability
 * left) is not offered, but it is still the gesture's: it is drawn as its own
 * id under "Not on this plan", so the row never claims the gesture runs
 * nothing while the file says it runs something.
 */
export function choicesFor(
  target: string | null,
  groups: readonly TargetGroup[],
): readonly TargetGroup[] {
  if (target === null || isOffered(target, groups)) return groups;
  return [
    {
      id: "unavailable",
      label: "Not on this plan",
      options: [{ id: target, label: target }],
    },
    ...groups,
  ];
}
