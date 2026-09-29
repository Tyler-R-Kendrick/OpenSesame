/**
 * The target and route the `sharing.live` capability contributes
 * (ADR 0150): the Settings › Live sessions tab, live only while the
 * capability is in the plan. Its two panels' targets are core-declared
 * (`catalog-more.ts`), as every panel a capability draws is.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const LIVE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.live",
    description:
      "The Live sessions settings category: host a live session from this tab, and the routes its sessions may use to reach people who are not on the same network.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "shared_sessions.live_host",
  },
];

export const LIVE_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/live",
    title: "Settings — live sessions: host one, and the routes it may use",
  },
];
