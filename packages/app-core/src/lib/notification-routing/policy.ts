/**
 * A preference only narrows what policy allows (ADR 0084 §3). The Identity
 * API intersects every preference with policy when it plans a route, so a
 * channel policy refused can never carry a prompt however it is listed. This
 * file keeps the screen from pretending otherwise: an edit — from the Form or
 * from the file — that would *add* a channel policy refused for a class is
 * refused here, before anything is sent, with the reason in words.
 *
 * What policy allows is read from the server's own route for the class
 * (`EffectiveRoute.allowed`), never guessed. A class whose route has not been
 * read admits nothing on the screen's say-so: the server's intersection is
 * still the rule, and this check only refuses what it knows policy refused.
 * A channel already in a class before policy tightened stays until the
 * person removes it — it finds nothing to select either way — so an edit
 * elsewhere is never blocked by a choice somebody made earlier.
 */

import { channelName } from "@opensesame/ceremony-kit";
import {
  NOTIFICATION_CLASSES,
  type NotificationChannelKind,
  type NotificationClass,
} from "@opensesame/os-domain";
import { CLASS_LABELS, type EffectiveRoute } from "./channels.js";
import { type NotificationRoutingDocument, preferenceFor } from "./document.js";

export type RoutesByClass = { [cls in NotificationClass]?: EffectiveRoute };

/** True, false, or null when the class's route has not been read. */
export function policyAllows(
  route: EffectiveRoute | undefined,
  kind: NotificationChannelKind,
): boolean | null {
  if (kind === "in_app") return true;
  if (!route) return null;
  return route.allowed.includes(kind);
}

/** The words for a channel policy refused in a class. */
export function policyRefusal(
  cls: NotificationClass,
  kind: NotificationChannelKind,
): string {
  return `Your operator's policy does not allow ${channelName(kind)} for "${CLASS_LABELS[cls]}". A preference can reorder and narrow what policy allows; it cannot add to it.`;
}

/**
 * Why `after` may not replace `before`: it adds, to some class, a channel
 * that class's policy refused. `null` when it admits nothing policy refused.
 */
export function admitsRefusedChannel(
  before: NotificationRoutingDocument,
  after: NotificationRoutingDocument,
  routes: RoutesByClass,
): string | null {
  for (const cls of NOTIFICATION_CLASSES) {
    const had = preferenceFor(before, cls).channels;
    for (const kind of preferenceFor(after, cls).channels) {
      if (had.includes(kind)) continue;
      if (policyAllows(routes[cls], kind) === false) {
        return policyRefusal(cls, kind);
      }
    }
  }
  return null;
}
