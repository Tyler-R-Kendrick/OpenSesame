/**
 * Where the keyboard lands on each rung of the join ceremony (AGENTS.md §5).
 *
 * The commit when it can be pressed, else the first thing to fill in; a
 * failure beside a field hands the keyboard to that field; and a rung with
 * nothing to fill in and a commit that waits (approval) still leaves it
 * somewhere — the foot's Start over, else Close. Never a disabled control,
 * never `<body>`.
 */

import { joinErrorField } from "@opensesame/app-core/screens/join/join-model.js";
import { type RefObject, useEffect, useRef } from "react";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";
import type { JoinCeremony } from "./useJoinCeremony.js";

export type JoinLandingRefs = Readonly<{
  go: RefObject<HTMLButtonElement | null>;
  body: RefObject<HTMLElement | null>;
  frame: RefObject<HTMLDivElement | null>;
}>;

/**
 * A focused control that became disabled holds nothing (browsers apply
 * focus fixup at different times), so it counts as idle too.
 */
function stranded(): boolean {
  const held = document.activeElement;
  return (
    keyboardIsIdle() || (held instanceof HTMLButtonElement && held.disabled)
  );
}

function land(owner: string | null, refs: JoinLandingRefs): void {
  if (owner && landFocus(document.getElementById(`join-${owner}`))) return;
  const go = refs.go.current;
  if (go && !go.disabled && landFocus(go)) return;
  if (landFocus(firstControl(refs.body.current))) return;
  const frame = refs.frame.current;
  if (landFocus(firstControl(frame?.querySelector(".setup__foot")))) return;
  landFocus(firstControl(frame));
}

export function useJoinLanding(join: JoinCeremony, refs: JoinLandingRefs) {
  const landed = useRef("");
  const { busy, road, step, error } = join;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable
  useEffect(() => {
    if (busy) return;
    const at = `${road}:${step}`;
    const owner = error ? joinErrorField(error) : null;
    if (landed.current === at && !stranded() && !owner) return;
    landed.current = at;
    land(owner, refs);
  }, [busy, road, step, error]);
}
