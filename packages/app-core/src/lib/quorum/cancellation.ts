/**
 * The owner's cancellation of one request: signed with the circle's owner key,
 * checked by a ledger against the key the policy names, and heard of by any
 * guardian device that is told.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { fromB64url, toB64url } from "./bytes.js";
import { frame } from "./canonical.js";
import type { Cancellation } from "./types.js";

const CANCEL_PURPOSE = "opensesame:quorum-cancel:v1";

export function cancellationBytes(
  c: Pick<Cancellation, "circleId" | "requestDigest" | "issuedAt">,
) {
  return frame([CANCEL_PURPOSE, c.circleId, c.requestDigest, c.issuedAt]);
}

/** The owner's cancellation of one request, signed with the circle's owner key. */
export function signCancellation(input: {
  circleId: string;
  requestDigest: string;
  ownerSecretKey: Uint8Array;
  now: Date;
}): Cancellation {
  const body = {
    circleId: input.circleId,
    requestDigest: input.requestDigest,
    issuedAt: input.now.toISOString(),
  };
  return {
    v: 1,
    kind: "cancellation",
    ...body,
    signature: toB64url(
      ed25519.sign(cancellationBytes(body), input.ownerSecretKey),
    ),
  };
}

/**
 * Whether the circle's owner key signed this cancellation. A guardian's device
 * and a ledger both ask it; it says nothing about which request is meant, which
 * the caller compares against the digest it holds.
 */
export function verifyCancellation(
  ownerKey: string,
  cancellation: Cancellation,
): boolean {
  try {
    return ed25519.verify(
      fromB64url(cancellation.signature),
      cancellationBytes(cancellation),
      fromB64url(ownerKey),
    );
  } catch {
    return false;
  }
}
