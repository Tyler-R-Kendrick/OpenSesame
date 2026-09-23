/**
 * `activity.log` — the durable, sealed app event log at `/activity`: its
 * section row, route, command path and `g y` jump, plus the legacy
 * `/wallet/activity` alias that redirects here.
 *
 * Egress: none. Events are read from the tomb (`config/activity-log`) and
 * never leave the device. Tutorial descriptors come from
 * `tutorial/registry/activity-catalog.ts` (`nav.activity`, `/activity`).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  ACTIVITY_ROUTES,
  ACTIVITY_TARGETS,
} from "@opensesame/app-core/tutorial/registry/activity-catalog.js";
import { ActivitySection } from "../../sections/ActivitySection.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { WalletActivityRedirect } from "./ActivityRedirect.js";

export const CAPABILITY = "activity.log";

export const TUTORIAL = {
  targets: ACTIVITY_TARGETS,
  routes: ACTIVITY_ROUTES,
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("section", {
      id: "activity",
      to: "/activity",
      label: "Activity",
      segment: "activity",
      jump: "y",
      icon: "clock",
      order: 60,
    });
    activation.register("route", {
      id: "activity",
      path: "/activity",
      element: ActivitySection,
      framed: true,
      order: 60,
    });
    activation.register("route", {
      id: "wallet-activity-alias",
      path: "/wallet/activity",
      element: WalletActivityRedirect,
      framed: false,
      order: 61,
    });
    activation.register("command-path", {
      path: "/activity",
      label: "Activity",
    });
    activation.register("keymap-jump", { key: "y", path: "/activity" });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
