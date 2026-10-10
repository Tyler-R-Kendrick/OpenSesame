/**
 * A guardian's side of the ceremonies (ADR 0186 §10): agree to be one, take a
 * share, say yes to one request, release a share after the delay, hear of a
 * cancellation, leave.
 *
 * A guardian's device decides from the policy it holds, never from what a
 * packet says about itself: a request is read against the signed policy the
 * owner's pinned key vouches for (`checkRequest`), and the sentence shown is the
 * one built from the request's own fields.
 */

import { seatOf } from "../approve.js";
import { toB64url } from "../bytes.js";
import { type Invite, enrollGuardian } from "../enroll.js";
import { applyEpoch } from "../epoch.js";
import { acceptDelivery } from "../guardian.js";
import { encodePacket, expectPacket } from "../packets.js";
import type { Welcome } from "../packets.js";
import { verifySignedPolicy } from "../policy.js";
import type { HeldRecord } from "../records.js";
import { keyFingerprint } from "../request.js";
import { checkSuccession } from "../succession.js";
import type { SignedPolicy } from "../types.js";
import { GuardianPendingSchema, KEYS, keyBytes, load, save } from "./docs.js";
import { DeskError, type DeskPorts } from "./ports.js";

/** An invitation, read and not yet agreed to. */
export type InviteView = Readonly<{
  invite: Invite;
  /** The owner key as a short name to check by another road. */
  ownerFingerprint: string;
  /** This page may run the ceremony: its origin is one the circle accepts. */
  originOk: boolean;
}>;

export function readInvitation(ports: DeskPorts, packet: string): InviteView {
  const invite = expectPacket(packet, "invite").value;
  return {
    invite,
    ownerFingerprint: keyFingerprint(invite.ownerKey),
    originOk: invite.origins.includes(ports.origin),
  };
}

/** An enrollment, to pass back to the owner, and the guardian id it carries. */
export type Accepted = Readonly<{ guardianId: string; enrollment: string }>;

/** Agree to be a guardian: register keys, sign the enrollment, keep the receiving key. */
export async function acceptInvitation(
  ports: DeskPorts,
  input: { packet: string; name: string; keyLabels: readonly string[] },
): Promise<Accepted> {
  const { invite } = readInvitation(ports, input.packet);
  const { enrollment, secrets } = await enrollGuardian({
    invite,
    currentOrigin: ports.origin,
    name: input.name,
    keyLabels: input.keyLabels,
    ceremony: ports.ceremony,
  });
  await save(
    ports.pending,
    KEYS.guardian(invite.inviteId),
    GuardianPendingSchema,
    {
      v: 1,
      invite,
      guardianId: enrollment.guardianId,
      name: input.name,
      hpkeSecretKey: toB64url(secrets.hpkeSecretKey),
    },
  );
  return {
    guardianId: enrollment.guardianId,
    enrollment: encodePacket({ kind: "enrollment", value: enrollment }),
  };
}

export async function heldFor(
  ports: DeskPorts,
  circleId: string,
): Promise<HeldRecord | undefined> {
  return (await ports.records.held()).find(
    (h) => h.seat.signedPolicy.policy.circleId === circleId,
  );
}

export async function requireHeld(
  ports: DeskPorts,
  circleId: string,
): Promise<HeldRecord> {
  const held = await heldFor(ports, circleId);
  if (!held) {
    throw new DeskError(
      "not_held",
      "this device holds nothing for that circle",
    );
  }
  return held;
}

/** The invitation this device accepted for a circle, if it has not yet been answered with a share. */
async function pendingFor(ports: DeskPorts, circleId: string) {
  for (const key of await ports.pending.list("guardian-pending:")) {
    const pending = await load(ports.pending, key, GuardianPendingSchema);
    if (pending?.invite.circleId === circleId) return { key, pending };
  }
  return null;
}

export type Taken = Readonly<{
  circleLabel: string;
  epoch: number;
  /** Proof the key reopened the share, to pass back to the owner. `null` for a circle with no shares. */
  receipt: string | null;
}>;

/** Who this device is in a circle, from what it holds or what it agreed to. */
type Standing = Readonly<{
  guardianId: string;
  /** The owner key pinned when the invitation was accepted. */
  pinned: string;
  receivingKey: Uint8Array;
  /** The policy already held, when this is a later epoch. */
  replaces: SignedPolicy | undefined;
  /** The pending enrollment to clear once a share is taken. */
  waitingKey: string | null;
}>;

async function standingIn(
  ports: DeskPorts,
  circleId: string,
): Promise<Standing> {
  const held = await heldFor(ports, circleId);
  if (held) {
    if (!held.receivingKey) {
      throw new DeskError("no_key", "the receiving key is gone");
    }
    return {
      guardianId: held.seat.guardianId,
      pinned: held.seat.signedPolicy.policy.ownerKey,
      receivingKey: held.receivingKey,
      replaces: held.seat.signedPolicy,
      waitingKey: null,
    };
  }
  const waiting = await pendingFor(ports, circleId);
  if (!waiting) {
    throw new DeskError(
      "no_invitation",
      "this device has not accepted an invitation to that circle",
    );
  }
  return {
    guardianId: waiting.pending.guardianId,
    pinned: waiting.pending.invite.ownerKey,
    receivingKey: keyBytes(waiting.pending.hpkeSecretKey),
    replaces: undefined,
    waitingKey: waiting.key,
  };
}

/** A circle that only authorizes actions: there is no share, so the guardian holds a seat. */
async function takeSeat(
  ports: DeskPorts,
  welcome: Welcome,
  standing: Standing,
): Promise<Taken> {
  const { policy } = welcome.signedPolicy;
  if (policy.operations.includes("recover-collection")) {
    throw new DeskError("no_share", "this circle holds shares but sent none");
  }
  const signed = standing.replaces
    ? checkSuccession(standing.replaces, welcome.signedPolicy, standing.pinned)
    : verifySignedPolicy(welcome.signedPolicy, standing.pinned);
  if (!signed.policy.guardians.some((g) => g.id === standing.guardianId)) {
    throw new DeskError(
      "not_a_guardian",
      "you are not a guardian in this policy",
    );
  }
  await ports.records.saveHeld({
    seat: { signedPolicy: signed, guardianId: standing.guardianId },
    holding: null,
    receivingKey: standing.receivingKey,
    state: "held",
  });
  return { circleLabel: policy.label, epoch: policy.epoch, receipt: null };
}

/** A circle with shares: verify, wrap under every key, reopen with a fresh touch, and prove it. */
async function takeShare(
  ports: DeskPorts,
  welcome: Welcome,
  delivery: NonNullable<Welcome["delivery"]>,
  standing: Standing,
): Promise<Taken> {
  const accepted = await acceptDelivery({
    delivery,
    signedPolicy: welcome.signedPolicy,
    pinnedOwnerKey: standing.pinned,
    guardianId: standing.guardianId,
    hpkeSecretKey: standing.receivingKey,
    ceremony: ports.ceremony,
    replaces: standing.replaces,
  });
  await ports.records.saveHeld({
    seat: seatOf(accepted.holding),
    holding: accepted.holding,
    receivingKey: standing.receivingKey,
    state: "held",
  });
  const { policy } = welcome.signedPolicy;
  return {
    circleLabel: policy.label,
    epoch: policy.epoch,
    receipt: encodePacket({ kind: "receipt", value: accepted.receipt }),
  };
}

/** Take what the owner sent: the policy and, when the circle has shares, this guardian's share. */
export async function takeWelcome(
  ports: DeskPorts,
  packet: string,
): Promise<Taken> {
  const welcome = expectPacket(packet, "welcome").value;
  const standing = await standingIn(
    ports,
    welcome.signedPolicy.policy.circleId,
  );
  const taken = welcome.delivery
    ? await takeShare(ports, welcome, welcome.delivery, standing)
    : await takeSeat(ports, welcome, standing);
  if (standing.waitingKey) await ports.pending.remove(standing.waitingKey);
  return taken;
}

export type NoticeOutcome = "retired" | "awaiting_share" | "adopted";

/** A policy for a circle this device holds, arriving by itself: a new epoch, or the end of a seat. */
export async function applyNotice(
  ports: DeskPorts,
  packet: string,
): Promise<NoticeOutcome> {
  const offered = expectPacket(packet, "policy").value;
  const held = await requireHeld(ports, offered.policy.circleId);
  const outcome = applyEpoch({
    seat: held.seat,
    offered,
    pinnedOwnerKey: held.seat.signedPolicy.policy.ownerKey,
  });
  if (outcome.state === "retired") {
    await ports.records.removeHeld(offered.policy.circleId);
    await ports.pending.remove(KEYS.cancelled(offered.policy.circleId));
  } else if (outcome.state === "adopted") {
    await ports.records.saveHeld({ ...held, seat: outcome.seat });
  }
  return outcome.state;
}
