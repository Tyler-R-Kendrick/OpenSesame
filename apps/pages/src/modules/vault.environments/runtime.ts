/**
 * `vault.environments` — named environments for a vault's keys (ADR 0190).
 * The key in the vault's path strip, the sheet it opens, and the tray notice
 * for a required value that is missing. All of it arrives here, so the shell
 * never imports it and a plan that leaves the capability off never loads it.
 *
 * Egress: none. Values stay sealed in the vault body; nothing is fetched.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { EnvironmentsEntry, EnvironmentsKey } from "./EnvironmentsKey.js";
import { EnvironmentsRedirect } from "./EnvironmentsRedirect.js";
import { startEnvironmentNotices } from "./watch.js";

export const CAPABILITY = "vault.environments";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    // After New item and Import, before Export.
    activation.register("vault-command", {
      id: "environments",
      order: 20,
      Command: EnvironmentsKey,
      Entry: EnvironmentsEntry,
    });
    // The typed road: `/environments` in the command bar, for a phone and a
    // keyboard alike. The route only redirects to the vault's own address.
    activation.register("route", {
      id: "environments",
      path: "/environments",
      element: EnvironmentsRedirect,
      framed: false,
      order: 62,
    });
    activation.register("command-path", {
      path: "/environments",
      label: "Environments",
    });
    activation.register("background-job", {
      id: "environments-notices",
      start: startEnvironmentNotices,
    });
    return activation.handle();
  },
};
