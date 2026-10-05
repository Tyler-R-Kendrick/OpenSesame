/**
 * The wordmark of a setup-framed screen (setup, join, the live-join gate) and
 * the seat the help key is drawn beside it (ADR 0166).
 */

import { Wordmark } from "../../components/Wordmark.js";
import { GateHelpSeat } from "../../tutorial/gate-seat.js";

export function SetupBrand() {
  return (
    <>
      <Wordmark className="setup__wordmark" />
      <GateHelpSeat />
    </>
  );
}
