/**
 * What a guardian's device does with a request (ADR 0187): approve it, and —
 * only after the delay — release the share to the recipient the request names.
 *
 * Before any of it the device checks the request against the policy it
 * already holds, never against what the requester sent: the owner's pinned
 * key signed that policy, the timings are the policy's, the sentence shown is
 * derived from the fields. A guardian cannot be talked into a different
 * circle, a different recipient or a shorter delay by a request that lies
 * about them.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { fromB64url, toB64url, utf8Bytes, wipe } from "./bytes.js";
import { frame } from "./canonical.js";
import type { Ceremony } from "./ceremony.js";
import { GuardianError, type Holding, guardianIn } from "./guardian.js";
import { sealBase } from "./hpke.js";
import { QuorumLedger } from "./ledger.js";
import { checkRequest, phaseChallenge, requestDigest } from "./request.js";
import type {
  Approval,
  QuorumRequest,
  Release,
  SignedPolicy,
} from "./types.js";
import { prfInput, unwrapShare } from "./wrap.js";

const RELEASE_INFO = "opensesame:quorum-release:v1";

/** Who is acting, and under which policy. All an approval needs. */
export type GuardianSeat = Readonly<{
  signedPolicy: SignedPolicy;
  guardianId: string;
}>;

export function seatOf(holding: Holding): GuardianSeat {
  return {
    signedPolicy: holding.signedPolicy,
    guardianId: holding.wrapped.guardianId,
  };
}

type Shared = Readonly<{
  request: BoundaryValue;
  ceremony: Ceremony;
  now: Date;
  /** True when the owner's cancellation of this request digest is known here. */
  isCancelled?: (digest: string) => boolean;
}>;

type ApprovalContext = Shared & Readonly<{ seat: GuardianSeat }>;
type ReleaseContext = Shared &
  Readonly<{
    holding: Holding;
    /**
     * The approvals the requester says the quorum gave. The device checks them
     * itself: a recipient's ledger is the recipient's own, and a recipient who
     * is the attacker will not enforce "a quorum first".
     */
    approvals: readonly BoundaryValue[];
  }>;

function prepare(context: Shared, seat: GuardianSeat) {
  const signed = seat.signedPolicy;
  const request = checkRequest(context.request, signed);
  const digest = requestDigest(request);
  if (context.isCancelled?.(digest)) {
    throw new GuardianError("cancelled", "the owner cancelled this request");
  }
  const at = context.now.getTime();
  if (at > new Date(request.expiresAt).getTime()) {
    throw new GuardianError("expired", "the request has lapsed");
  }
  return {
    signed,
    request,
    digest,
    guardian: guardianIn(signed, seat.guardianId),
  };
}

/** Approve a request. Gives no share and needs no PRF: it says "yes", once. */
export async function buildApproval(
  context: ApprovalContext,
): Promise<Approval> {
  const { signed, request, digest, guardian } = prepare(context, context.seat);
  if (context.now.getTime() > new Date(request.approveBy).getTime()) {
    throw new GuardianError("window", "the approval window has closed");
  }
  const asserted = await context.ceremony.assert({
    rpId: signed.policy.rpId,
    challenge: phaseChallenge("approve", digest),
    allowCredentialIds: guardian.credentials.map((c) => c.credentialId),
    requireUserVerification: signed.policy.requireUserVerification,
  });
  return {
    v: 1,
    kind: "approval",
    requestDigest: digest,
    guardianId: guardian.id,
    credentialId: asserted.credentialId,
    assertion: asserted.proof,
  };
}

/**
 * Check, on this device, that this guardian approved and that approvals
 * satisfying the policy exist. Approvals that do not verify simply do not
 * count; a signature carries no time, so none is read from them (see
 * `QuorumLedger.verifying`).
 */
async function confirmQuorum(
  signed: SignedPolicy,
  request: QuorumRequest,
  approvals: readonly BoundaryValue[],
  self: string,
): Promise<void> {
  const check = QuorumLedger.verifying(signed, request);
  for (const approval of approvals) await check.submitApproval(approval);
  if (!check.approvedGuardians().includes(self)) {
    throw new GuardianError(
      "not_approved",
      "this guardian has not approved the request",
    );
  }
  if (!check.quorumMet()) {
    throw new GuardianError(
      "quorum",
      "the approvals shown do not satisfy the circle's policy",
    );
  }
}

/**
 * Release this guardian's share to the request's recipient. Refused before
 * `releaseNotBefore`: a guardian's device is where the delay is kept, since
 * a quorum with the shares in hand could otherwise skip it.
 */
export async function buildRelease(context: ReleaseContext): Promise<Release> {
  const { signed, request, digest, guardian } = prepare(
    context,
    seatOf(context.holding),
  );
  if (request.operation !== "recover-collection") {
    throw new GuardianError("no_release", "this operation releases no share");
  }
  if (context.now.getTime() < new Date(request.releaseNotBefore).getTime()) {
    throw new GuardianError("too_early", "the release delay has not passed");
  }
  await confirmQuorum(signed, request, context.approvals, guardian.id);
  const { policy } = signed;
  const { wrapped } = context.holding;
  const asserted = await context.ceremony.assert({
    rpId: policy.rpId,
    challenge: phaseChallenge("release", digest),
    allowCredentialIds: wrapped.envelopes.map((e) => e.credentialId),
    requireUserVerification: policy.requireUserVerification,
    prfInput: prfInput(policy.circleId, guardian.id),
  });
  const output = asserted.prfOutput;
  const envelope = wrapped.envelopes.find(
    (e) => e.credentialId === asserted.credentialId,
  );
  if (!output || !envelope)
    throw new GuardianError("no_prf", "the key did not open the share");
  const mnemonic = unwrapShare(
    envelope,
    {
      circleId: policy.circleId,
      guardianId: guardian.id,
      credentialId: asserted.credentialId,
      epoch: policy.epoch,
    },
    output,
  );
  wipe(output);
  const sealed = sealBase({
    recipientPublicKey: fromB64url(request.recipient.hpkePublicKey),
    info: utf8Bytes(RELEASE_INFO),
    aad: releaseAad(digest, guardian.id),
    plaintext: utf8Bytes(mnemonic),
  });
  return {
    v: 1,
    kind: "release",
    requestDigest: digest,
    guardianId: guardian.id,
    credentialId: asserted.credentialId,
    assertion: asserted.proof,
    sealed: {
      enc: toB64url(sealed.enc),
      ciphertext: toB64url(sealed.ciphertext),
    },
  };
}

/** The AAD a released share is sealed under: this request, this guardian. */
export function releaseAad(digest: string, guardianId: string): Uint8Array {
  return frame([RELEASE_INFO, digest, guardianId]);
}

export const RELEASE_HPKE_INFO = RELEASE_INFO;
