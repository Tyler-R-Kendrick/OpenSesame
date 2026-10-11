/**
 * A guardian acting on a request (ADR 0187 §10): read it, say yes to it,
 * release a share after the delay, hear of a cancellation, leave a circle.
 * Becoming a guardian and taking a share are in `guardian.ts`.
 *
 * A guardian's device decides from the policy it holds, never from what a
 * packet says about itself: a request is read against the signed policy the
 * owner's pinned key vouches for (`checkRequest`), and the sentence shown is the
 * one built from the request's own fields.
 */

import { buildApproval, buildRelease } from "../approve.js";
import { verifyCancellation } from "../cancellation.js";
import { decodePacket, encodePacket, expectPacket } from "../packets.js";
import type { HeldRecord, ShareState } from "../records.js";
import { checkRequest, keyFingerprint, requestDigest } from "../request.js";
import type { Approval, QuorumRequest } from "../types.js";
import { CancelledSchema, KEYS, load, save } from "./docs.js";
import { requireHeld } from "./guardian.js";
import { DeskError, type DeskPorts } from "./ports.js";

async function cancelledDigests(
  ports: DeskPorts,
  circleId: string,
): Promise<ReadonlySet<string>> {
  const stored = await load(
    ports.pending,
    KEYS.cancelled(circleId),
    CancelledSchema,
  );
  return new Set(stored ?? []);
}

/** The owner's cancellation of a request, verified against the key this device pinned. */
export async function noteCancellation(
  ports: DeskPorts,
  packet: string,
): Promise<string> {
  const cancellation = expectPacket(packet, "cancellation").value;
  const held = await requireHeld(ports, cancellation.circleId);
  if (
    !verifyCancellation(held.seat.signedPolicy.policy.ownerKey, cancellation)
  ) {
    throw new DeskError(
      "bad_signature",
      "the owner did not sign this cancellation",
    );
  }
  const known = await cancelledDigests(ports, cancellation.circleId);
  await save(
    ports.pending,
    KEYS.cancelled(cancellation.circleId),
    CancelledSchema,
    [...new Set([...known, cancellation.requestDigest])],
  );
  return cancellation.requestDigest;
}

/** Where in its life a request is, as this device's clock sees it. */
export type Phase = "approve" | "wait" | "release" | "over" | "cancelled";

export type RequestView = Readonly<{
  circleLabel: string;
  operation: QuorumRequest["operation"];
  /** The sentence every guardian reads: built from the request's fields. */
  summary: string;
  recipientLabel: string;
  recipientFingerprint: string;
  approveBy: string;
  releasableAt: string;
  expiresAt: string;
  phase: Phase;
  digest: string;
  /** This device holds a share it could release for this request. */
  canRelease: boolean;
}>;

function phaseOf(
  request: QuorumRequest,
  now: number,
  cancelled: boolean,
): Phase {
  if (cancelled) return "cancelled";
  if (now > new Date(request.expiresAt).getTime()) return "over";
  if (now <= new Date(request.approveBy).getTime()) return "approve";
  if (now < new Date(request.releaseNotBefore).getTime()) return "wait";
  return "release";
}

/** Read a request against the policy this device holds. A request that lies about its circle is refused. */
export async function readRequest(
  ports: DeskPorts,
  packet: string,
): Promise<RequestView> {
  const raw = expectPacket(packet, "request").value;
  const held = await requireHeld(ports, raw.circleId);
  const request = checkRequest(raw, held.seat.signedPolicy);
  const digest = requestDigest(request);
  const cancelled = (await cancelledDigests(ports, raw.circleId)).has(digest);
  return {
    circleLabel: held.seat.signedPolicy.policy.label,
    operation: request.operation,
    summary: request.summary,
    recipientLabel: request.recipient.label,
    recipientFingerprint: keyFingerprint(request.recipient.hpkePublicKey),
    approveBy: request.approveBy,
    releasableAt: request.releaseNotBefore,
    expiresAt: request.expiresAt,
    phase: phaseOf(request, ports.now().getTime(), cancelled),
    digest,
    canRelease:
      held.holding !== null && request.operation === "recover-collection",
  };
}

async function note(ports: DeskPorts, held: HeldRecord, state: ShareState) {
  await ports.records.saveHeld({ ...held, state });
}

/** Say yes to one request, with a key. Gives no share and needs no PRF. */
export async function approveRequest(
  ports: DeskPorts,
  packet: string,
): Promise<string> {
  const request = expectPacket(packet, "request").value;
  const held = await requireHeld(ports, request.circleId);
  const cancelled = await cancelledDigests(ports, request.circleId);
  const approval = await buildApproval({
    seat: held.seat,
    request,
    ceremony: ports.ceremony,
    now: ports.now(),
    isCancelled: (digest) => cancelled.has(digest),
  });
  await note(ports, held, "approved");
  return encodePacket({ kind: "approval", value: approval });
}

function approvalsIn(packet: string): Approval[] {
  const decoded = decodePacket(packet);
  if (decoded.kind === "approval") return [decoded.value];
  if (decoded.kind === "approvals") return decoded.value;
  throw new DeskError("kind", `this is a ${decoded.kind}, not approvals`);
}

/**
 * Release this guardian's share to the recipient the request names. The device
 * checks for itself that the approvals satisfy the policy and that the delay
 * has passed; a recipient's say-so is not enough.
 */
export async function releaseShare(
  ports: DeskPorts,
  input: { request: string; approvals: string },
): Promise<string> {
  const request = expectPacket(input.request, "request").value;
  const held = await requireHeld(ports, request.circleId);
  if (!held.holding) {
    throw new DeskError("no_share", "this circle holds no share to release");
  }
  const cancelled = await cancelledDigests(ports, request.circleId);
  const release = await buildRelease({
    holding: held.holding,
    approvals: approvalsIn(input.approvals),
    request,
    ceremony: ports.ceremony,
    now: ports.now(),
    isCancelled: (digest) => cancelled.has(digest),
  });
  await note(ports, held, "released");
  return encodePacket({ kind: "release", value: release });
}

/** Leave a circle: forget the share and the seat. The owner is not told by this; say so. */
export async function leaveCircle(
  ports: DeskPorts,
  circleId: string,
): Promise<void> {
  await requireHeld(ports, circleId);
  await ports.records.removeHeld(circleId);
  await ports.pending.remove(KEYS.cancelled(circleId));
}
