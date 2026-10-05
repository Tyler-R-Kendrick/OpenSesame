/**
 * The chrome keys a gate screen keeps in its corner: the theme key, and the
 * seat the help key is drawn in (ADR 0165). One component, so the front door
 * and the unlock form cannot drift on what sits in the corner.
 */

import { GateHelpSeat } from "../tutorial/gate-seat.js";
import { ThemeToggle } from "./ThemeToggle.js";

export function GateTools({ tabIndex }: { tabIndex?: number }) {
  return (
    <>
      <ThemeToggle tabIndex={tabIndex} />
      <GateHelpSeat />
    </>
  );
}
