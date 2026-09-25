/**
 * What a `/claim` link brought, held between boot and the route (ADR 0140
 * plan step 8).
 *
 * `bootCore` takes the link out of the address before the first paint
 * (`captureClaimLink`), on the claim route only: a `#token=` elsewhere is
 * somebody else's (Join's invite, a sign-in return) and is not read here.
 * What arrived waits in memory until the route, behind unlock, takes it:
 *
 *   - an ownership claim's bearer also goes to the tab's claim stash, so it
 *     survives a sign-in that leaves the page;
 *   - a drop — bearer and key — is held in memory only: a drop opens in one
 *     sitting, and its key is never written anywhere;
 *   - a bearer that arrived in the query string is `leaked`: scrubbed,
 *     refused, never presented.
 *
 * The route that takes it never touches the vault (ADR 0140 §2), so nothing
 * here waits on an unlock. Signing out forgets all of it (`session-exit.ts`),
 * and so does every vault lock (D6, `bindClaimLockReset`, bound by the core
 * boot): the stash exists only to carry a bearer across a federated sign-in
 * redirect, not to outlive the sitting it arrived in.
 */

import { ceremonyPath } from "@opensesame/ceremony-kit";
import { env } from "../../host.js";
import { maybePage } from "../../ports.js";
import { underBase } from "../device-link.js";
import { onVaultLock } from "../vault/lock-events.js";
import { type ClaimArrival, captureClaimLink } from "./link.js";
import { claimStash, clearClaimStash } from "./stash.js";

const NONE: ClaimArrival = { kind: "none" };

let held: ClaimArrival = NONE;
let unbindLock: (() => void) | null = null;

/** `/OpenSesame/claim` under base `/OpenSesame/`; `/claim` under `/`. */
export function claimPath(base: string): string {
  return `${base.replace(/\/+$/, "")}${ceremonyPath("claim")}`;
}

/** Keep an arrival: a claim's bearer also goes to the stash, a drop never. */
function hold(arrival: ClaimArrival): void {
  held = arrival;
  if (arrival.kind !== "claim") return;
  // The same bearer reopened in this tab keeps what it had done: a presented
  // claim is read back, never presented twice.
  if (claimStash.read()?.token === arrival.token) return;
  claimStash.write({ token: arrival.token, presented: false });
}

/**
 * Take a claim link out of this page's address, before anything renders
 * (boot), or when the route mounts on an address boot did not see. Nothing
 * is read on any other path.
 */
export function captureClaimArrivalFromPage(): ClaimArrival {
  const page = maybePage();
  if (!page) return NONE;
  const at = underBase(page.location.pathname, env().BASE_URL || "/");
  if (at !== ceremonyPath("claim")) return NONE;
  const arrival = captureClaimLink();
  if (arrival.kind !== "none") hold(arrival);
  return arrival;
}

/** Look without taking: the route's first render. */
export function peekClaimArrival(): ClaimArrival {
  return held;
}

/** Hand the waiting arrival over, and forget it here. */
export function takeClaimArrival(): ClaimArrival {
  const taken = held;
  held = NONE;
  return taken;
}

/** Forget the arrival and the stashed bearer: sign-out, lock, a spent claim. */
export function forgetClaim(): void {
  held = NONE;
  clearClaimStash();
}

/**
 * Purge on every vault lock (ADR 0140 D6). Bound once, by the core boot, on
 * the store's lock bus — not by a component, because the ceremony routes
 * render without the shell and a lock must purge whatever is on screen.
 */
export function bindClaimLockReset(): () => void {
  unbindLock ??= onVaultLock(forgetClaim);
  return () => {
    unbindLock?.();
    unbindLock = null;
  };
}

export function resetClaimArrivalForTests(): void {
  held = NONE;
}
