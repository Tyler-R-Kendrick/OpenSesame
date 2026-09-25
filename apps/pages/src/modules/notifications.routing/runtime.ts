/**
 * `notifications.routing` — where the Identity API tells a person about
 * requests (ADR 0084; ADR 0140 D9): Settings › Notifications, which replaces
 * `apps/ceremonies`' `/notifications` page. Optional, in the Notifications
 * feature: nothing of it reaches the page before the plan approved it and a
 * consent receipt covered its exposure (ADR 0130).
 *
 * Contributed: the Notifications settings category — its panel, and its
 * files (`settings/notifications/routing.json`, `channels.json`,
 * `bindings.json`, ADR 0134), both drawn from one routing session this
 * activation creates and `dispose` drops — and its walkthrough
 * (`tutorial/registry/notifications-catalog.ts`).
 *
 * Egress this module wraps, all to the configured Identity API through
 * `identityFetch` (`app-core/lib/notification-routing/transport.ts`), and
 * only once Settings › Notifications is opened with an Identity session:
 * `GET /v1/notification-channels`, `GET /v1/notification-channels/bindings`,
 * `GET /v1/notification-preferences` and `…/effective?class=` (one per
 * class); on a key or a file save, `PUT /v1/notification-preferences`,
 * `POST /v1/notification-channels/bindings` and
 * `DELETE /v1/notification-channels/bindings/{id}`. With no Identity API
 * configured it sends nothing. Side effects: none at import, none on
 * activation.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  currentSession,
  isRemoteIdentityConfigured,
} from "@opensesame/app-core/lib/identity.js";
import {
  NOTIFICATIONS_GOALS,
  NOTIFICATIONS_ROUTES,
  NOTIFICATIONS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/notifications-catalog.js";
import { createElement } from "react";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { createRoutingSession } from "./session.js";

export const CAPABILITY = "notifications.routing";

export const TUTORIAL = {
  targets: NOTIFICATIONS_TARGETS,
  goals: NOTIFICATIONS_GOALS,
  routes: NOTIFICATIONS_ROUTES,
} as const;

/** Whom the session reads for: a session on a configured Identity API. */
function identity(): string | null {
  if (!isRemoteIdentityConfigured()) return null;
  return currentSession()?.principalId ?? null;
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    const session = createRoutingSession(identity);
    activation.onDispose(() => session.dispose());
    const Panel = () => createElement(NotificationsPanel, { session });
    activation.register("settings-category", {
      id: "notifications",
      label: "Notifications",
      guideId: "settings.notifications",
      Panel,
      order: 300,
      files: session.files,
    });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
