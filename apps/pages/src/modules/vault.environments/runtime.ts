/**
 * `vault.environments` — the optional Environment item type. An Environment
 * item holds one varlock-compatible `.env.schema` body, its environment name,
 * and explicit alias bindings to named vault items. The capability adds the
 * item kind; it no longer adds a key to the vault strip, a sheet, a route, or
 * a background notice.
 *
 * Egress: none. The item and its aliases stay sealed in the vault body.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.environments";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("item-kind", {
      kind: "environment",
      label: "Environments",
      segment: "environments",
      order: 80,
    });
    return activation.handle();
  },
};
