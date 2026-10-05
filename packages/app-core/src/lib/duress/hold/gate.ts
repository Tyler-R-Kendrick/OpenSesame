/**
 * The unlock-side reading of the hold (ADR 0167): while it stands, the vault's
 * real credentials are refused as a wrong secret is.
 *
 * Read at the vault store's unlock choke points, after a credential has been
 * checked and before it is allowed to open anything. Not frozen: the guest and
 * decoy tombs (guest access is never removed), the duress code itself (it
 * matches before any unwrap and may extend the hold), and creating a vault.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import { isGuestSessionTomb } from "../store/decoy-scratch.js";
import { MAX_HOLD_MS, readHold } from "./record.js";

/** Slack on the 72 h ceiling before a clock set far back reads as unreliable. */
const CLOCK_GRACE_MS = 60_000;

/**
 * Whether a real vault is held right now. An absent, expired or malformed
 * record is not a hold; neither is one that is further off than the longest
 * choice could ever be, which only a clock set well back can produce.
 */
export function isFrozen(now: number = Date.now()): boolean {
  const held = readHold();
  if (!held) return false;
  const remaining = held.until - now;
  return remaining > 0 && remaining <= MAX_HOLD_MS + CLOCK_GRACE_MS;
}

/**
 * Throws what a wrong secret throws, with the same text the method's own miss
 * uses, when `tomb` is a real vault and the device is held; otherwise returns.
 * `onRefuse` runs first: it counts the refusal as the failed unlock a wrong
 * secret is, and lets go of any key material the credential just opened.
 */
export function refuseWhileFrozen(
  tomb: string,
  onRefuse: () => void,
  miss?: string,
): void {
  if (isGuestSessionTomb(tomb) || !isFrozen()) return;
  onRefuse();
  throw miss === undefined
    ? new WrongPasswordError()
    : new WrongPasswordError(miss);
}
