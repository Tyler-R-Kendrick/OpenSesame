/**
 * An `/invoke/<kind>` link, read before the first paint and held for the
 * route (ADR 0140 §2, plan step 10). The link is read by ceremony-kit's
 * bounded reader (`readInvocationArrival`) and nothing else; its query — a
 * user code, a request id or a request URI — leaves the address here and is
 * kept in memory only, never stored. Kept apart from `invoke-route.ts` so
 * the core boot pulls in no notices and no screen model.
 */

import {
  type InvocationArrival,
  readInvocationArrival,
} from "@opensesame/ceremony-kit";
import { maybePage } from "../ports.js";

const NONE: InvocationArrival = { kind: "none" };

let held: InvocationArrival = NONE;
/** The path the held arrival was read on, once its address was scrubbed. */
let heldAt = "";

/**
 * Boot, and the route on an address boot did not see: read the link, scrub
 * the address, and keep what it carried. A bare path already answered — the
 * one this link left behind — is not a fresh arrival: what was read there
 * stays, so the route coming back still hands the same request on.
 */
export function captureInvocationArrivalFromPage(): InvocationArrival {
  const page = maybePage();
  if (!page) return NONE;
  const { arrival, scrubbed } = readInvocationArrival(page.location.href);
  if (scrubbed !== null) page.replaceUrl(scrubbed);
  if (arrival.kind === "none") return arrival;
  const at = page.location.pathname;
  if (scrubbed === null && held.kind !== "none" && heldAt === at) return held;
  held = arrival;
  heldAt = at;
  return arrival;
}

/** What the last `/invoke/<kind>` address carried, and where. */
export function peekInvocationArrival(): {
  arrival: InvocationArrival;
  at: string;
} {
  return { arrival: held, at: heldAt };
}

export function resetInvocationArrivalForTests(): void {
  held = NONE;
  heldAt = "";
}
