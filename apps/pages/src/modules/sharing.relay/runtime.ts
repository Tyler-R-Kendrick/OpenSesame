/**
 * `sharing.relay` — optional vault-relay client (ADR 0181).
 *
 * The module registers nothing. Pairing a relay and pushing a snapshot is a
 * separate consent from live join, and this runtime does not open a socket
 * at import or at activation. The client lives in app-core and runs only
 * when a caller names a relay.
 *
 * Egress: none. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.relay";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
