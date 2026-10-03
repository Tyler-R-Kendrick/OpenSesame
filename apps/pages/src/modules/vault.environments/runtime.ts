/**
 * `vault.environments` — named environments on a vault. The Settings › Vaults
 * panel is the only surface: it is registered here, so the shell never
 * imports it and a plan that leaves the capability off never loads it.
 *
 * Egress: none. Values stay in this tab.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { notifyMissingEnvironmentValues } from "@opensesame/app-core/lib/vault/environments.js";
import { createActivation } from "../activation.js";
import { LiveEnvironmentsPanel } from "./EnvironmentsPanel.js";

export const CAPABILITY = "vault.environments";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.onDispose(() => {
      notifyMissingEnvironmentValues(null, "", []);
    });
    activation.register("settings-panel", {
      id: "vault-environments",
      label: "Environments",
      category: "vaults",
      Panel: LiveEnvironmentsPanel,
      order: 60,
    });
    return activation.handle();
  },
};
