/**
 * What a guardian's device checks before it lets a new policy replace the one
 * it holds (ADR 0186 §9). Separate from `epoch.ts` so the guardian's side of
 * taking a share can use it without importing the owner's side of making one.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { verifySignedPolicy } from "./policy.js";
import type { SignedPolicy } from "./types.js";

export class EpochError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EpochError";
  }
}

/**
 * A policy offered to a guardian who holds `held`: checked before it replaces
 * anything. It must be the owner's (the key pinned at the invitation), the
 * same circle and RP ID, and **later** — an equal or earlier epoch is a replay.
 * The very next epoch must also name the digest held; a guardian who was away
 * for several can only check the owner's signature on the one they are shown.
 */
export function checkSuccession(
  held: SignedPolicy,
  offered: BoundaryValue,
  pinnedOwnerKey: string,
): SignedPolicy {
  const next = verifySignedPolicy(offered, pinnedOwnerKey);
  const was = held.policy;
  const now = next.policy;
  if (now.circleId !== was.circleId) {
    throw new EpochError("circle", "this policy is for another circle");
  }
  if (now.epoch <= was.epoch) {
    throw new EpochError(
      "rollback",
      "this policy is not newer than the one already held",
    );
  }
  if (now.rpId !== was.rpId) {
    throw new EpochError("rp_id", "the RP ID of a circle cannot change");
  }
  if (now.epoch === was.epoch + 1 && now.supersedes?.digest !== held.digest) {
    throw new EpochError(
      "chain",
      "this policy does not replace the one held here",
    );
  }
  return next;
}
