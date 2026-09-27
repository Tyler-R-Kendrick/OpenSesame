/**
 * A capability waiting for a fresh document (RELOAD_REQUIRED) holds back
 * whatever depends on it: a dependent that started now would run without the
 * thing it depends on. The wait flows up `dependencyOf`, transitively, to
 * every approved dependent. It never approves or refuses anything.
 */
import { sortReasons } from "./reasons.js";
import type { CapabilityId, CapabilityState } from "./types.js";

export function holdDependentsForReload(
  capabilities: Record<CapabilityId, CapabilityState>,
): void {
  const pending = Object.values(capabilities)
    .filter((s) => s.reasons.includes("RELOAD_REQUIRED"))
    .map((s) => s.id);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const waiting = Object.hasOwn(capabilities, id) ? capabilities[id] : null;
    for (const dependent of waiting?.dependencyOf ?? []) {
      const state = Object.hasOwn(capabilities, dependent)
        ? capabilities[dependent]
        : undefined;
      if (!state?.approved || state.reasons.includes("RELOAD_REQUIRED"))
        continue;
      capabilities[dependent] = {
        ...state,
        reasons: sortReasons([...state.reasons, "RELOAD_REQUIRED"]),
      };
      pending.push(dependent);
    }
  }
}
