/**
 * An `/approve/<ref>` link, read before the first paint and held for the
 * route (ADR 0140 §2, plan step 9). The reference is read by ceremony-kit's
 * bounded parser (`readApprovalArrival`) and nothing else; a query or a
 * fragment that rode along leaves the address here, and one naming
 * credential material refuses the link. Kept apart from `approvals.ts` so
 * the core boot pulls in no review, client or authenticator.
 */

import {
  type ApprovalArrival,
  readApprovalArrival,
} from "@opensesame/ceremony-kit";
import { maybePage } from "../ports.js";

const NONE: ApprovalArrival = { kind: "none" };

let held: ApprovalArrival = NONE;
/** The path the held arrival was read on, once its address was scrubbed. */
let heldAt = "";

/**
 * Boot, and the route on an address boot did not see: read the link, scrub
 * the address, and keep what it carried. Nothing is read on any other path.
 */
export function captureApprovalArrivalFromPage(): ApprovalArrival {
  const page = maybePage();
  if (!page) return NONE;
  const { arrival, scrubbed } = readApprovalArrival(page.location.href);
  if (scrubbed !== null) page.replaceUrl(scrubbed);
  if (arrival.kind === "none") return arrival;
  const at = page.location.pathname;
  // A refused link left a clean path behind; reading that path again is not
  // a fresh arrival, and must not open what the link was refused for.
  if (held.kind === "refused" && heldAt === at) return held;
  held = arrival;
  heldAt = at;
  return arrival;
}

/** What the last `/approve/<ref>` address carried, for the route to open. */
export function peekApprovalArrival(): ApprovalArrival {
  return held;
}

export function resetApprovalArrivalForTests(): void {
  held = NONE;
  heldAt = "";
}
