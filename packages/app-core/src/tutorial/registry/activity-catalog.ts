/**
 * Targets the `activity.log` capability contributes. Its route is its
 * section's path and is registered as a `tutorial-route` beside them.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const ACTIVITY_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "nav.activity",
    description:
      "Rail entry that opens Activity, the durable log of vault, settings, access and request events.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const ACTIVITY_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/activity", title: "Activity — what happened on this device" },
];
