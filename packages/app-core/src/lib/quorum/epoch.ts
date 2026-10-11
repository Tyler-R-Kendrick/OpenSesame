/**
 * Changing a circle (ADR 0187 §9): refreshing every share, replacing a
 * guardian, adding one, or changing the rule. All of them are one thing, a new
 * **epoch**: the owner signs a new policy that names the digest of the one it
 * replaces, draws a fresh recovery secret, re-seals the payload under it and
 * deals new shares. Nothing is edited in place.
 *
 * What a new epoch does and does not do, because both matter:
 * - Shares of different epochs never combine. A new epoch's secret is drawn
 *   fresh, so a guardian removed from the circle, or a share that leaked, opens
 *   nothing of the new bundle.
 * - It does **not** take back what an old quorum could already read. The old
 *   bundle is a file; whoever kept it and enough old shares can still open it.
 *   Replacing a guardian protects the future. A secret that was exposed still
 *   needs rotating at its provider.
 * - A guardian never goes back. A device that took epoch 3 refuses epoch 2's
 *   policy, delivery and requests, so an attacker cannot replay an old,
 *   weaker rule (a lower threshold, a guardian since removed).
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import type { GuardianSeat } from "./approve.js";
import type { Json } from "./canonical.js";
import {
  type CircleDraft,
  type CreatedCircle,
  type OwnerKeys,
  assembleCircle,
} from "./circle.js";
import { verifySignedPolicy } from "./policy.js";
import { EpochError, checkSuccession } from "./succession.js";
import type { SignedPolicy } from "./types.js";

/** A new epoch, with who is in it and who is out. */
export type Reissued = CreatedCircle &
  Readonly<{
    /** Guardians of the old epoch who are not in the new one: tell them, send no share. */
    retired: readonly string[];
    /** In the new epoch and not the old: they enrolled for this and have no earlier share. */
    joined: readonly string[];
    /** In both: a new share each, and the old one can be deleted. */
    kept: readonly string[];
  }>;

/**
 * The next epoch of a circle. `draft` is the whole new rule: its guardians,
 * groups and thresholds. To refresh the shares alone, pass the same ones.
 *
 * Kept as fixed, because a guardian's keys are registered against them: the
 * circle id, the RP ID, and the receiving key of anyone who stays. A person
 * whose device is lost enrolls again as a new guardian and the old entry is
 * retired.
 */
export async function reissueCircle(input: {
  previous: BoundaryValue;
  owner: OwnerKeys;
  draft: CircleDraft;
  /** Required when the new epoch recovers a collection: it is sealed again. */
  payload?: Json;
  now: Date;
}): Promise<Reissued> {
  const previous = verifySignedPolicy(input.previous, input.owner.publicKey);
  const before = previous.policy;
  const { draft } = input;
  if (draft.circleId !== before.circleId) {
    throw new EpochError("circle", "a new epoch keeps the circle it replaces");
  }
  if (draft.rpId !== before.rpId) {
    throw new EpochError(
      "rp_id",
      "guardians' keys are registered under the RP ID, so it cannot change",
    );
  }
  if (input.now.getTime() < new Date(before.createdAt).getTime()) {
    throw new EpochError("clock", "a new epoch cannot predate the one before");
  }
  const old = new Map(before.guardians.map((g) => [g.id, g]));
  const next = new Map(draft.guardians.map((g) => [g.id, g]));
  for (const [id, guardian] of next) {
    const was = old.get(id);
    if (was && was.hpkePublicKey !== guardian.hpkePublicKey) {
      throw new EpochError(
        "guardian_changed",
        "a guardian who stays keeps their receiving key; enroll a new one",
      );
    }
  }
  const created = await assembleCircle({
    draft,
    owner: input.owner,
    payload: input.payload,
    now: input.now,
    succession: {
      epoch: before.epoch + 1,
      supersedes: { epoch: before.epoch, digest: previous.digest },
    },
  });
  return {
    ...created,
    retired: [...old.keys()].filter((id) => !next.has(id)),
    joined: [...next.keys()].filter((id) => !old.has(id)),
    kept: [...next.keys()].filter((id) => old.has(id)),
  };
}

/** What a guardian's device does about a new epoch. */
export type EpochOutcome =
  | Readonly<{ state: "retired" }>
  | Readonly<{ state: "awaiting_share"; signedPolicy: SignedPolicy }>
  | Readonly<{ state: "adopted"; seat: GuardianSeat }>;

/**
 * A new epoch's policy reaches a guardian, on its own or with their share.
 * Not in it any more: drop the holding. In it and holding shares: the new share
 * is dealt separately, take it with `acceptDelivery` (`replaces` the held
 * policy) and only then delete the old one. In an action-only circle there
 * is no share, so the new policy is adopted now.
 */
export function applyEpoch(input: {
  seat: GuardianSeat;
  offered: BoundaryValue;
  pinnedOwnerKey: string;
}): EpochOutcome {
  const next = checkSuccession(
    input.seat.signedPolicy,
    input.offered,
    input.pinnedOwnerKey,
  );
  if (!next.policy.guardians.some((g) => g.id === input.seat.guardianId)) {
    return { state: "retired" };
  }
  if (next.policy.operations.includes("recover-collection")) {
    return { state: "awaiting_share", signedPolicy: next };
  }
  return {
    state: "adopted",
    seat: { signedPolicy: next, guardianId: input.seat.guardianId },
  };
}
