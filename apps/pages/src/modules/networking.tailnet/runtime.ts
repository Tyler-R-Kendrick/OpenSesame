/**
 * `networking.tailnet` — the Networking feature: binding this installation
 * to a Tailscale tailnet over which a Host or daemon is reached.
 *
 * The networking connector bindings (`networking` in the embedded catalogue)
 * are drawn by Settings › Capabilities under the Networking feature, and
 * only while this capability is in the plan; the connector page each tile
 * opens belongs to `connectors.external`. This module therefore registers
 * nothing of its own yet: the id exists so a person can switch Networking
 * on and off, and an operator can prohibit it, with the tiles following.
 *
 * Egress: none of its own. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "networking.tailnet";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
