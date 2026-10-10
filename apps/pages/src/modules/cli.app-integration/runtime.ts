/**
 * `cli.app-integration` — Pages shell for CLI terminal approvals.
 * The authorize UI and daemon polling land in the stacked UI PR (#1084);
 * this stub satisfies the capability inventory for the backend slice (#1080).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "cli.app-integration";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    return activation.handle();
  },
};
