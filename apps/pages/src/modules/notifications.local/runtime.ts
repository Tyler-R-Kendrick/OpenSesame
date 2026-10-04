/**
 * `notifications.local` — tells the person who holds this vault that a request
 * is waiting, while the app is open or in the background (ADR 0162, on ADR
 * 0084). Optional, in its own Settings › Capabilities section: nothing of it
 * reaches the page before the plan approved it and a consent receipt covered
 * its exposure (ADR 0130).
 *
 * Contributed:
 *  - an unlock effect, one watcher per open vault. It reads the device's inbox
 *    (`lib/device-inbox.ts`) when something changes — a request raised or
 *    decided in this tab, or in another tab of this origin (a message between
 *    them, `lib/local-iam-events.ts`) — and rings the places the person and
 *    the device allow: the bell in the tray, the tab's title and badge, and a
 *    system notification when the tab is in the background. It stops, and
 *    takes every mark down, when the vault locks;
 *  - the section's panel and its file (`settings/capabilities/
 *    local-notifications.json`): which places the person wants, narrowed to
 *    what the device allows.
 *
 * Egress: none. There is no server, no push service and no request out of the
 * browser: a notification is the browser's own `Notification` and the
 * document's own title. A notice carries `{ kind, action, ref }` and never a
 * name, a scope or a reason, and nothing it rings can decide anything: a click
 * arrives at the list a request is decided from.
 *
 * Side effects: none at import; nothing on activation but registering. The
 * browser's `notifications` permission is asked for only when its key in the
 * panel is pressed, never here (ownership.md §4.3).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { registerDeviceRoutes } from "@opensesame/app-core/lib/device-identity-routes.js";
import { listInbox } from "@opensesame/app-core/lib/device-inbox.js";
import { readPreference } from "@opensesame/app-core/lib/local-notifications/preference.js";
import { LOCAL_NOTIFICATIONS_DEVICE_ROUTES } from "@opensesame/app-core/lib/local-notifications/routes.js";
import { watchInbox } from "@opensesame/app-core/lib/local-notifications/watch.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { localNotificationFiles } from "@opensesame/app-core/sections/settings/local-notifications-files.js";
import {
  LOCAL_NOTIFICATIONS_GOALS,
  LOCAL_NOTIFICATIONS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/notifications-catalog.js";
import { sectionCategory } from "../../sections/settings/CapabilitySections.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { LocalNotificationsPanel } from "./LocalNotificationsPanel.js";
import { browserPorts } from "./delivery.js";

export const CAPABILITY = "notifications.local";

/** The walkthrough of its panel (`tutorial/registry/notifications-catalog.ts`). */
export const TUTORIAL = {
  targets: LOCAL_NOTIFICATIONS_TARGETS,
  goals: LOCAL_NOTIFICATIONS_GOALS,
} as const;

/** The Capabilities section this capability's panel is drawn in. */
export const SECTION = "feature-local-notifications";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // The device's `notifications` family (ADR 0160 §3): present exactly
    // while this capability is, answering that the inbox is its one channel.
    activation.onDispose(
      registerDeviceRoutes(LOCAL_NOTIFICATIONS_DEVICE_ROUTES),
    );

    activation.register("settings-panel", {
      id: "local-notifications",
      label: "On this device",
      category: sectionCategory(SECTION),
      Panel: LocalNotificationsPanel,
      order: 10,
      files: localNotificationFiles(() => vaultStore.activeTomb()),
    });

    // One watcher per unlocked vault, for as long as it stays unlocked. The
    // effect's signal aborts on lock, on a new unlock generation and when the
    // lease ends, and the watcher takes its marks down when it does.
    activation.register("unlock-effect", {
      id: "local-request-watch",
      run: ({ tomb, signal }) =>
        watchInbox(
          browserPorts(ctx.navigate, {
            list: () => listInbox(tomb),
            preference: () => readPreference(tomb),
          }),
          signal,
        ),
    });

    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
