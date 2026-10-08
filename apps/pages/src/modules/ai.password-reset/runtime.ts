/**
 * `ai.password-reset` — mailbox scan for the website password-reset
 * ceremony. The mailbox panel lives in Settings › Capabilities and draws
 * with the section once the capability is approved; only the scan loads here.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { startPasswordResetScan } from "./scan.js";

export const CAPABILITY = "ai.password-reset";

/** Matches `sectionCategory("feature-password-reset")`. */
export const PASSWORD_RESET_PANEL_CATEGORY =
  "capabilities.feature-password-reset";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("background-job", {
      id: "password-reset-mail",
      start: startPasswordResetScan,
    });
    return activation.handle();
  },
};
