/**
 * An `/i/<ref>` link, read before the first paint and held for the route
 * (ADR 0140 §2, plan step 9). Split from `interactions.ts` so the core boot
 * reads the address without pulling in the ceremony, its client or the
 * WebAuthn port: those arrive with the route, after boot.
 *
 * Only an `/i/<ref>` path is read — every other address is left alone, a
 * sign-in callback's `?code=` above all — and ceremony-kit's
 * `readInteractionArrival` is the one parser: a fragment always leaves, a
 * query naming credential material leaves whole and refuses the link. The
 * reference stays in the path: it authorizes nothing (ADR 0086 §3).
 */

import {
  type InteractionArrival,
  matchCeremonyPath,
  readInteractionArrival,
} from "@opensesame/ceremony-kit";
import { maybePage } from "../ports.js";

const NONE: InteractionArrival = { kind: "none" };

let held: InteractionArrival = NONE;
/** The path the held arrival was read on, once its address was scrubbed. */
let heldAt = "";

/**
 * Take an interaction link out of this page's address, before anything
 * renders or calls. The legacy shapes elsewhere are the device route's.
 */
export function captureInteractionLink(): InteractionArrival {
  const page = maybePage();
  if (!page) return NONE;
  const { location } = page;
  if (matchCeremonyPath("interaction", location.pathname) === null) {
    return NONE;
  }
  const { arrival, scrubbed } = readInteractionArrival(location.href);
  if (scrubbed !== null) page.replaceUrl(scrubbed);
  return arrival;
}

/**
 * Boot, and the route on an address boot did not see (an in-app
 * navigation): read the link and keep what it carried. Only an arrival that
 * holds something replaces what is waiting.
 */
export function captureInteractionArrivalFromPage(): InteractionArrival {
  const arrival = captureInteractionLink();
  if (arrival.kind === "none") return arrival;
  const at = maybePage()?.location.pathname ?? "";
  // A refused link left a clean path behind; reading that path again is not
  // a fresh arrival, and must not open what the link was refused for.
  if (held.kind === "refused" && heldAt === at) return held;
  held = arrival;
  heldAt = at;
  return arrival;
}

/** What the last `/i/<ref>` address carried, for the route to open. */
export function peekInteractionArrival(): InteractionArrival {
  return held;
}

export function resetInteractionArrivalForTests(): void {
  held = NONE;
  heldAt = "";
}
