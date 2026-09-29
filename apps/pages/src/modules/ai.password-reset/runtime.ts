/**
 * `ai.password-reset` — mailboxes for the existing website password-reset
 * ceremony. The panel and the scan load only after this capability is
 * approved. Login items read the mailbox list from core and stay hidden
 * until then.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { PasswordResetMailPanel } from "./panel.js";
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
    activation.register("settings-panel", {
      id: "password-reset-mail",
      label: "Password reset",
      category: PASSWORD_RESET_PANEL_CATEGORY,
      Panel: PasswordResetMailPanel,
      order: 10,
    });
    activation.register("background-job", {
      id: "password-reset-mail",
      start: startPasswordResetScan,
    });
    return activation.handle();
  },
};
