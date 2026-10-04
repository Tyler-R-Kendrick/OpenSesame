/**
 * The `notifications` family of the device Identity plane, as
 * `notifications.local` contributes it (ADR 0160 §3, ADR 0162).
 *
 * The device delivers to exactly one channel, the in-app inbox, so the one
 * thing it can truthfully answer is the channel listing: every kind the
 * vocabulary names, and only that one configured. A panel written against the
 * Identity API's listing therefore reads the device's truth. Every other
 * route of the family — the routing document, a destination's binding, the
 * effective route — is the Identity API's, needs a server in the world
 * (ADR 0160 §3), and is not answered: `null` leaves it unserved (501).
 *
 * It registers from `activate` and goes on dispose, so the family is served
 * only while the capability is on.
 */

import {
  type JsonObject,
  NOTIFICATION_CHANNEL_KINDS,
} from "@opensesame/os-domain";
import type {
  DeviceRouteContribution,
  DeviceRouteRequest,
} from "../device-identity-routes.js";

function answer(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function notificationsRoute(
  request: DeviceRouteRequest,
): Promise<Response | null> {
  if (request.bare !== "/v1/notification-channels") return null;
  if (request.method !== "GET")
    return answer({ error: "method_not_allowed" }, 405);
  if (request.caller === null) return answer({ error: "unauthorized" }, 401);
  return answer({
    channels: NOTIFICATION_CHANNEL_KINDS.map((kind) => ({
      kind,
      configured: kind === "in_app",
    })),
  });
}

export const LOCAL_NOTIFICATIONS_DEVICE_ROUTES: DeviceRouteContribution = {
  id: "notifications.local",
  routes: { notifications: notificationsRoute },
};
