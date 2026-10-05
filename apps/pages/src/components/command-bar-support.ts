import { useSupportIfMounted } from "../tutorial/support-access.js";

/**
 * A model capability registers command-assist. Without one, the bar parses
 * commands only: navigate, search, copy. With one, a sentence no verb claims
 * is a question. Support learns whether that model can answer only once it is
 * opened, so an unknown availability is still a road in; a known absence keeps
 * the honest no-match.
 */
export function useSupportRoad(hasAssist: boolean) {
  const supportAccess = useSupportIfMounted();
  const availability = supportAccess?.view.availability ?? null;
  const canAsk =
    hasAssist &&
    supportAccess !== null &&
    (availability === null || availability.kind === "ready") &&
    !supportAccess.view.thinking;
  return { canAsk, support: supportAccess?.support ?? null };
}
