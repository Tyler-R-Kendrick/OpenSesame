/**
 * Targets, routes and the walkthrough the `notifications.routing` capability
 * contributes (ADR 0084; ADR 0140 D9): Settings › Notifications, live only
 * while the capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goals.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const NOTIFICATIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.notifications",
    description:
      "The Notifications settings category: the channels this deployment has, the destinations you connected, and the order each kind of request tries them. Where you are told never changes what it takes to approve.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "identity.notification.preferences.manage",
  },
];

export const NOTIFICATIONS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/notifications",
    title: "Settings — notifications: channels, destinations and their order",
  },
];

export const NOTIFICATIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.notifications",
    title: "Choose where you hear about requests",
    // Offered on Settings only: a walkthrough of a settings page.
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.notifications"',
      'say "A preference only orders where you are told about a request. It never changes what it takes to approve, and a channel your operator refused stays refused."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/notifications"',
      'wait route "/settings/notifications" timeout=15000',
      'focus "settings.notifications" "Each kind of request has its own order. Move a channel earlier or later, add one your operator allows, or connect a destination for it first." side=bottom',
      "end",
    ].join("\n"),
  },
];
