/**
 * `sharing.relay` — optional vault-relay client (ADR 0181).
 *
 * The module registers the organization-vault directory. Pairing a relay and
 * pushing a snapshot is a separate consent from live join, and this runtime
 * does not open a socket at import or at activation. The client lives in
 * app-core and runs only when a caller names a relay.
 *
 * Egress: none. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { sectionCategory } from "../../sections/settings/CapabilitySections.js";
import { createActivation } from "../activation.js";
import { OrgVaultDirectoryPanel } from "./OrgVaultDirectoryPanel.js";

export const CAPABILITY = "sharing.relay";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("settings-panel", {
      id: "org-vault-directory",
      label: "Organization vaults",
      category: sectionCategory("feature-sharing"),
      Panel: OrgVaultDirectoryPanel,
      order: 40,
    });
    return activation.handle();
  },
};
