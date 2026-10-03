/**
 * `notifications.routing` — where the Identity API tells a person about
 * requests (ADR 0084; ADR 0140 D9): Settings › Notifications. Optional, in
 * the Notifications feature: nothing of it reaches the page before the plan
 * approved it and a
 * consent receipt covered its exposure (ADR 0130).
 *
 * Contributed: the Notifications settings category — its panel, and its
 * files (`settings/notifications/routing.json`, `channels.json`,
 * `bindings.json`, ADR 0134), both drawn from one routing session this
 * activation creates and `dispose` drops — and its walkthrough
 * (`tutorial/registry/notifications-catalog.ts`), which navigates to that page
 * and so is declared and revoked with it.
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
import { subscribeSettings } from "@opensesame/app-core/lib/settings.js";
import {
  NOTIFICATIONS_GOALS,
  NOTIFICATIONS_ROUTES,
  NOTIFICATIONS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/notifications-catalog.js";
import type { RegistrationHandle } from "@opensesame/capability-composition";
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
    // With no Identity API there is nothing to read, bind or order: the page
    // would be one inbox row nobody can change (ADR 0158 §4). The category
    // is there while a service is named, and goes with it.
    let category: RegistrationHandle | null = null;
    let guide: readonly RegistrationHandle[] = [];
    const follow = () => {
      if (activation.disposed()) return;
      const wanted = isRemoteIdentityConfigured();
      if (wanted && category === null) {
        category = activation.register("settings-category", {
          id: "notifications",
          label: "Notifications",
          guideId: "settings.notifications",
          Panel,
          panels: [{ id: "notif-channels", label: "Channels" }],
          order: 300,
          files: session.files,
        });
        // The walkthrough navigates to the page: it lives only with the page.
        guide = registerTutorial(activation, TUTORIAL);
      } else if (!wanted && category !== null) {
        category.revoke();
        category = null;
        for (const handle of guide) handle.revoke();
        guide = [];
      }
    };
    follow();
    activation.onDispose(subscribeSettings(follow));

    return activation.handle();
  },
};
