/**
 * Where this device can tell its person that a request is waiting, and what
 * each place is trusted with (ADR 0162, on ADR 0084).
 *
 * Two questions look like one here too. *Where would I like to hear about
 * it?* is the person's preference. *Where may a notification go at all?* is
 * the device's policy: what this browser supports and what the person has
 * permitted. The composition is one-directional. A preference may reorder and
 * narrow what policy allows; it can never add a place policy refused. And
 * none of these places can settle anything: the tab title and a system
 * notification are doorbells (`notify`), and the only place a request is ever
 * decided is the in-app ceremony, which no preference can turn off and no
 * other place can stand in for.
 *
 * Pure: no document, no `Notification`, no storage. The device reads its
 * environment and hands it in.
 */

import {
  CHANNEL_CAPABILITIES,
  type ChannelInteractionMode,
  interactionRank,
} from "@opensesame/os-domain";

/** Every place a notice can go. A closed set. */
export const LOCAL_DESTINATIONS = ["in_app", "tab_title", "system"] as const;

export type LocalDestination = (typeof LOCAL_DESTINATIONS)[number];

/**
 * How far each place may be trusted to carry a decision. The in-app
 * ceremony's is the catalogue's own (`interactive`); the other two ring a
 * doorbell and nothing more, so a notification that is clicked arrives at the
 * ceremony and decides nothing on the way.
 */
export const LOCAL_DESTINATION_MODE = {
  in_app: CHANNEL_CAPABILITIES.in_app.maximumInteractionMode,
  tab_title: "notify",
  system: "notify",
} as const satisfies Readonly<Record<LocalDestination, ChannelInteractionMode>>;

/** Whether a decision may be made from this place. Only the ceremony. */
export function mayDecideFrom(destination: LocalDestination): boolean {
  return (
    interactionRank(LOCAL_DESTINATION_MODE[destination]) >=
    interactionRank("interactive")
  );
}

/** What the browser permits a system notification, as `Notification` says. */
export type SystemPermission = "granted" | "denied" | "default" | "unsupported";

/** What this device offers, read by the page and handed in. */
export type LocalEnvironment = Readonly<{
  /** There is a document whose title can carry a mark. */
  tabTitle: boolean;
  system: SystemPermission;
}>;

/**
 * The places policy allows on this device, in no order of preference. The
 * in-app one is always there. A system notification is allowed only once the
 * person has granted the browser's permission, which is asked for on an
 * explicit action and never on its own.
 */
export function allowedDestinations(
  environment: LocalEnvironment,
): readonly LocalDestination[] {
  return LOCAL_DESTINATIONS.filter((destination) => {
    if (destination === "in_app") return true;
    if (destination === "tab_title") return environment.tabTitle;
    return environment.system === "granted";
  });
}

/**
 * Where a notice goes: the person's order, narrowed to what policy allows.
 * Nothing the preference names that policy did not allow survives, nothing is
 * added, and the in-app place is always first-class: a preference that leaves
 * it out gets it anyway, because the inbox cannot be turned off (ADR 0084).
 */
export function effectiveDestinations(
  preferred: readonly LocalDestination[],
  allowed: readonly LocalDestination[],
): readonly LocalDestination[] {
  const chosen = new Set<LocalDestination>();
  for (const destination of preferred)
    if (allowed.includes(destination)) chosen.add(destination);
  const ordered = [...chosen];
  return ordered.includes("in_app") ? ordered : ["in_app", ...ordered];
}
