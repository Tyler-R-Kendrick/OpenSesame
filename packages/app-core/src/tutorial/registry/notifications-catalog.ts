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

/**
 * What the `notifications.local` capability contributes (ADR 0162): its panel
 * inside Settings › Capabilities, live only while the capability is in the
 * plan. A walkthrough of a doorbell on this device, with no service in it.
 */
export const LOCAL_NOTIFICATIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.local-notifications",
    description:
      "Local notifications under Capabilities: how this device tells you that a request is waiting. A key that allows system notifications, asked for by the browser only when you press it, and a key for the count in the tab's title. The bell always tells you, and nothing here decides a request.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "identity.notification.local.manage",
  },
];

export const LOCAL_NOTIFICATIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.local-notifications",
    title: "Choose how this device tells you a request is waiting",
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.local-notifications"',
      'say "A request that is waiting is shown on the bell. Here you can also have it in the tab title and, if you allow it, as a system notification when the app is in the background. Nothing leaves this device, and a notification never approves anything."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.local-notifications" "The browser asks for permission only when you press the key for system notifications. The bell and the Requests list always show what is waiting." side=bottom',
      "end",
    ].join("\n"),
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
