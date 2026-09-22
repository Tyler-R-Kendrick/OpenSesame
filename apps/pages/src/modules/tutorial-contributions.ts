/**
 * Tutorial descriptors a module contributes are the *existing* authored
 * entries of `tutorial/registry`, named by id. The prose stays in one place
 * (ADR 0088: checked-in, never interpolated), and a module only says which
 * ids are live while it is active. An id that is not declared is a bug in
 * the module, so it throws at activation rather than registering nothing.
 */

import type { Activation } from "./activation.js";
import { GUIDE_TARGETS } from "../tutorial/registry/catalog.js";
import { GUIDE_GOALS } from "../tutorial/registry/goals.js";
import { GUIDE_ROUTES } from "../tutorial/registry/routes.js";

export type TutorialSelection = Readonly<{
  targets?: readonly string[];
  goals?: readonly string[];
  routes?: readonly string[];
}>;

function pick<T extends { readonly id: string }>(
  all: readonly T[],
  ids: readonly string[],
  kind: string,
): T[] {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`tutorial ${kind} not declared: ${id}`);
    return entry;
  });
}

export function registerTutorial(
  activation: Activation,
  selection: TutorialSelection,
): void {
  for (const target of pick(GUIDE_TARGETS, selection.targets ?? [], "target")) {
    activation.register("tutorial-target", target);
  }
  for (const goal of pick(GUIDE_GOALS, selection.goals ?? [], "goal")) {
    activation.register("tutorial-goal", goal);
  }
  for (const route of pick(GUIDE_ROUTES, selection.routes ?? [], "route")) {
    activation.register("tutorial-route", route);
  }
}
