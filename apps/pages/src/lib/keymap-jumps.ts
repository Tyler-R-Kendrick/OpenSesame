/**
 * The `g` section jumps: the two the core shell always has, and one per
 * `keymap-jump` contribution from the capability whose section it opens, so
 * a letter for an excluded capability is not bound at all (SURFACE-09).
 *
 * A contributed jump is also gated when it is pressed, not only when it is
 * listed (ownership.md §4.2): the capability that registered it must still
 * be approved under a current lease. A refused jump answers null, exactly as
 * an unbound letter does, so the chord swallows it rather than moving.
 */

import { isCapabilityDenied } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  assertNavigationContribution,
  contributionsSnapshot,
} from "@opensesame/app-core/lib/contributions.js";

const CORE_JUMPS: ReadonlyMap<string, string> = new Map([
  ["v", "/vault"],
  ["s", "/settings"],
]);

/**
 * The path `g <key>` opens, or null when nothing registered that key or the
 * capability that registered it no longer holds authority.
 */
export function sectionJumpPath(key: string): string | null {
  const core = CORE_JUMPS.get(key);
  if (core !== undefined) return core;
  const jump = contributionsSnapshot("keymap-jump").find(
    (entry) => entry.key === key,
  );
  if (!jump) return null;
  try {
    assertNavigationContribution(
      "keymap-jump",
      (entry) => entry.key === jump.key && entry.path === jump.path,
    );
  } catch (error) {
    if (isCapabilityDenied(error)) return null;
    throw error;
  }
  return jump.path;
}

/** Every jump key that exists right now, in the rail's order. */
export function sectionJumpKeys(): readonly string[] {
  const sections = contributionsSnapshot("section");
  const orderOf = (path: string): number =>
    path === "/vault"
      ? 0
      : path === "/settings"
        ? 1000
        : (sections.find((section) => section.to === path)?.order ?? 500);
  const jumps = new Map<string, string>(CORE_JUMPS);
  for (const jump of contributionsSnapshot("keymap-jump")) {
    if (!jumps.has(jump.key)) jumps.set(jump.key, jump.path);
  }
  return [...jumps]
    .sort(([, left], [, right]) => orderOf(left) - orderOf(right))
    .map(([key]) => key);
}
