import {
  type InteractionArrival,
  readInteractionArrival,
} from "@opensesame/ceremony-kit";

/**
 * What this app was opened on (ADR 0086).
 *
 * The reading is `@opensesame/ceremony-kit`'s `readInteractionArrival`, the
 * same one Pages makes (ADR 0140 plan step 5): canonical `/i/<ref>` first,
 * the legacy user-code shapes second, a link carrying credential material
 * refused, and anything else `none`. The one thing this module owns is
 * browser contact: `window.location` and `history.replaceState`.
 *
 * Unconditional, and first: the fragment (and a legacy link's code, and a
 * refused link's query) leaves the address bar before any call is made,
 * because it survives in history, in a screenshot and in a share sheet.
 */
export type OpenedLink = InteractionArrival;

export function readOpenedLink(): OpenedLink {
  const { arrival, scrubbed } = readInteractionArrival(window.location.href);
  if (scrubbed !== null) window.history.replaceState(null, "", scrubbed);
  return arrival;
}
