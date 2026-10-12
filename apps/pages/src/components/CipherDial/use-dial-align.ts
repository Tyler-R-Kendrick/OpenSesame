import { type RefObject, useEffect } from "react";
import type { CipherDialPhase } from "./cipher-dial-phase.js";
import { T_CLICK_MS } from "./constants.js";
import type { DialLayout } from "./layout-types.js";
import { alignRings } from "./ring-motion.js";

export function useDialAlign(
  layoutRef: RefObject<DialLayout | null>,
  phase: CipherDialPhase,
  alignStartMs: number | null,
): void {
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || phase !== "align" || alignStartMs === null) return;
    alignRings(layout.rings, alignStartMs, T_CLICK_MS);
  }, [alignStartMs, layoutRef, phase]);
}
