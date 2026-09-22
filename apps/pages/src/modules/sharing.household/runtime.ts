/**
 * `sharing.household` — the household sharing root. It has no surface of
 * its own: everything a household shares travels over the `transport`
 * alternative slot, which today `sharing.drops` satisfies (ownership.md §5).
 * The runtime exists so the alternative is explicit in the plan and the
 * loader has one module per approved capability; it registers nothing and
 * returns a handle whose dispose is a no-op.
 *
 * Egress: none of its own. A future transport (a local peer road) would be
 * a sibling capability in the slot, never code added here.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.household";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
