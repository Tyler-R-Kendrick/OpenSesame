/**
 * What a guardian's device does with a share (ADR 0186): take delivery, keep
 * it wrapped under their keys, and prove it reopens. Approving a request and
 * releasing the share are in `approve.ts`.
 *
 * Before any of it the device checks the request against the policy it
 * already holds, never against what the requester sent: the owner's pinned
 * key signed that policy, the timings are the policy's, the sentence shown is
 * derived from the fields. A guardian cannot be talked into a different
 * circle, a different recipient or a shorter delay by a request that lies
 * about them.
 */

import { sha256 } from "@noble/hashes/sha2";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { fromB64url, utf8Bytes, utf8Text, wipe } from "./bytes.js";
import { frame } from "./canonical.js";
import type { Ceremony } from "./ceremony.js";
import {
  type ShareDelivery,
  ShareDeliverySchema,
  deliveryAad,
} from "./circle.js";
import { openBase } from "./hpke.js";
import { credentialOf, guardianById, verifySignedPolicy } from "./policy.js";
import { checkSuccession } from "./succession.js";
import {
  AssertionProofSchema,
  type SignedPolicy,
  SignedPolicySchema,
} from "./types.js";
import { AssertionError, verifyAssertion } from "./webauthn.js";
import {
  type WrappedShare,
  WrappedShareSchema,
  prfInput,
  shareCommitment,
  unwrapShare,
  wrapShare,
} from "./wrap.js";

const DELIVERY_INFO = "opensesame:quorum-delivery:v1";
const CUSTODY_PURPOSE = "opensesame:quorum-custody:v1";

export class GuardianError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardianError";
  }
}

/** What a guardian keeps for one circle: the signed policy and their wrapped share. */
export type Holding = Readonly<{
  signedPolicy: SignedPolicy;
  wrapped: WrappedShare;
}>;

/** A holding read back from storage: the policy is re-verified against the pinned owner key. */
export function parseHolding(
  input: BoundaryValue,
  pinnedOwnerKey: string,
): Holding {
  const raw = z
    .object({ signedPolicy: SignedPolicySchema, wrapped: WrappedShareSchema })
    .parse(input);
  const signedPolicy = verifySignedPolicy(raw.signedPolicy, pinnedOwnerKey);
  const { wrapped } = raw;
  if (wrapped.policyDigest !== signedPolicy.digest) {
    throw new GuardianError(
      "holding",
      "the wrapped share is for another policy",
    );
  }
  return { signedPolicy, wrapped };
}

export const CustodyReceiptSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("custody-receipt"),
    circleId: z.string(),
    guardianId: z.string(),
    epoch: z.number().int().min(1),
    policyDigest: z.string(),
    commitment: z.string(),
    credentialId: z.string(),
    /** Every key that now wraps the share. */
    wrappedCredentialIds: z.array(z.string()).min(1),
    assertion: AssertionProofSchema,
  })
  .strict();
export type CustodyReceipt = z.infer<typeof CustodyReceiptSchema>;

/** The challenge for wrapping and for the round trip that proves the wrap. */
export function custodyChallenge(
  phase: "wrap" | "verify",
  policyDigest: string,
  guardianId: string,
  commitment: string,
): Uint8Array {
  return sha256(
    frame([CUSTODY_PURPOSE, phase, policyDigest, guardianId, commitment]),
  );
}

export function guardianIn(signed: SignedPolicy, guardianId: string) {
  const guardian = guardianById(signed.policy, guardianId);
  if (!guardian)
    throw new GuardianError(
      "not_a_guardian",
      "this guardian is not in the circle",
    );
  return guardian;
}

function openDelivery(
  delivery: ShareDelivery,
  signed: SignedPolicy,
  guardianId: string,
  hpkeSecretKey: Uint8Array,
): string {
  const { policy } = signed;
  if (
    delivery.circleId !== policy.circleId ||
    delivery.guardianId !== guardianId ||
    delivery.epoch !== policy.epoch
  ) {
    throw new GuardianError(
      "delivery",
      "this share is for another circle, guardian or epoch",
    );
  }
  const mnemonic = utf8Text(
    openBase({
      recipientSecretKey: hpkeSecretKey,
      enc: fromB64url(delivery.enc),
      info: utf8Bytes(DELIVERY_INFO),
      aad: deliveryAad(delivery.circleId, delivery.guardianId, delivery.epoch),
      ciphertext: fromB64url(delivery.ciphertext),
    }),
  );
  const expected = policy.shareCommitments[guardianId];
  if (shareCommitment(policy.circleId, guardianId, mnemonic) !== expected) {
    throw new GuardianError(
      "commitment",
      "the share is not the one the owner's policy committed to",
    );
  }
  return mnemonic;
}

/** A share in hand: kept wrapped, with the receipt that proves it reopens. */
export type AcceptedDelivery = Readonly<{
  holding: Holding;
  receipt: CustodyReceipt;
}>;

/**
 * Take delivery of a share and wrap it under each key the guardian presents,
 * then prove it opens: a fresh assertion unwraps what was just wrapped and
 * the result is checked against the owner's commitment. A guardian who cannot
 * reopen their own share finds out now, not in the emergency.
 */
export async function acceptDelivery(input: {
  delivery: BoundaryValue;
  signedPolicy: BoundaryValue;
  pinnedOwnerKey: string;
  guardianId: string;
  hpkeSecretKey: Uint8Array;
  ceremony: Ceremony;
  /** Wrap for these credentials. Defaults to every PRF-capable one. */
  credentialIds?: readonly string[];
  /**
   * The policy this guardian already holds for the circle. Given, the new one
   * must be a later epoch of it (`checkSuccession`): a share of an older or
   * unrelated policy is refused before any key is touched.
   */
  replaces?: SignedPolicy;
}): Promise<AcceptedDelivery> {
  const signed = input.replaces
    ? checkSuccession(input.replaces, input.signedPolicy, input.pinnedOwnerKey)
    : verifySignedPolicy(input.signedPolicy, input.pinnedOwnerKey);
  const { policy } = signed;
  const guardian = guardianIn(signed, input.guardianId);
  const delivery = ShareDeliverySchema.parse(input.delivery);
  const mnemonic = openDelivery(
    delivery,
    signed,
    guardian.id,
    input.hpkeSecretKey,
  );
  const commitment = policy.shareCommitments[guardian.id] ?? "";
  const chosen = guardian.credentials.filter(
    (c) =>
      c.prf &&
      (input.credentialIds ?? [c.credentialId]).includes(c.credentialId),
  );
  if (chosen.length === 0) {
    throw new GuardianError(
      "no_prf",
      "no key that can protect a share was presented",
    );
  }
  const envelopes = [];
  for (const credential of chosen) {
    const asserted = await input.ceremony.assert({
      rpId: policy.rpId,
      challenge: custodyChallenge(
        "wrap",
        signed.digest,
        guardian.id,
        commitment,
      ),
      allowCredentialIds: [credential.credentialId],
      requireUserVerification: policy.requireUserVerification,
      prfInput: prfInput(policy.circleId, guardian.id),
    });
    const output = asserted.prfOutput;
    if (!output)
      throw new GuardianError("no_prf", "the key returned no PRF output");
    envelopes.push(
      wrapShare(
        mnemonic,
        {
          circleId: policy.circleId,
          guardianId: guardian.id,
          credentialId: credential.credentialId,
          epoch: policy.epoch,
        },
        output,
      ),
    );
    wipe(output);
  }
  const wrapped: WrappedShare = {
    v: 1,
    circleId: policy.circleId,
    guardianId: guardian.id,
    epoch: policy.epoch,
    policyDigest: signed.digest,
    envelopes,
  };
  const holding: Holding = { signedPolicy: signed, wrapped };
  const receipt = await verifyHolding(holding, commitment, input.ceremony);
  return { holding, receipt };
}

/** Unwrap with a fresh assertion and check the commitment; the assertion is the custody receipt's proof. */
async function verifyHolding(
  holding: Holding,
  commitment: string,
  ceremony: Ceremony,
): Promise<CustodyReceipt> {
  const { signedPolicy: signed, wrapped } = holding;
  const { policy } = signed;
  const asserted = await ceremony.assert({
    rpId: policy.rpId,
    challenge: custodyChallenge(
      "verify",
      signed.digest,
      wrapped.guardianId,
      commitment,
    ),
    allowCredentialIds: wrapped.envelopes.map((e) => e.credentialId),
    requireUserVerification: policy.requireUserVerification,
    prfInput: prfInput(policy.circleId, wrapped.guardianId),
  });
  const output = asserted.prfOutput;
  const envelope = wrapped.envelopes.find(
    (e) => e.credentialId === asserted.credentialId,
  );
  if (!output || !envelope)
    throw new GuardianError("no_prf", "the key did not reopen the share");
  const mnemonic = unwrapShare(
    envelope,
    {
      circleId: policy.circleId,
      guardianId: wrapped.guardianId,
      credentialId: asserted.credentialId,
      epoch: policy.epoch,
    },
    output,
  );
  wipe(output);
  if (
    shareCommitment(policy.circleId, wrapped.guardianId, mnemonic) !==
    commitment
  ) {
    throw new GuardianError(
      "commitment",
      "the reopened share does not match the commitment",
    );
  }
  return {
    v: 1,
    kind: "custody-receipt",
    circleId: policy.circleId,
    guardianId: wrapped.guardianId,
    epoch: policy.epoch,
    policyDigest: signed.digest,
    commitment,
    credentialId: asserted.credentialId,
    wrappedCredentialIds: wrapped.envelopes.map((e) => e.credentialId),
    assertion: asserted.proof,
  };
}

/** The owner checks that a guardian's key really reopened the share. */
export async function verifyCustodyReceipt(
  signed: SignedPolicy,
  input: BoundaryValue,
): Promise<CustodyReceipt> {
  const receipt = CustodyReceiptSchema.parse(input);
  const { policy } = signed;
  const guardian = guardianIn(signed, receipt.guardianId);
  const credential = credentialOf(guardian, receipt.credentialId);
  const commitment = policy.shareCommitments[guardian.id];
  if (
    !credential ||
    receipt.policyDigest !== signed.digest ||
    receipt.commitment !== commitment ||
    receipt.epoch !== policy.epoch
  ) {
    throw new GuardianError(
      "receipt",
      "the receipt is not for this policy and guardian",
    );
  }
  try {
    await verifyAssertion(credential, receipt.assertion, {
      challenge: custodyChallenge(
        "verify",
        signed.digest,
        guardian.id,
        receipt.commitment,
      ),
      rpId: policy.rpId,
      origins: policy.origins,
      requireUserVerification: policy.requireUserVerification,
      lastCounter: 0,
    });
  } catch (error) {
    if (error instanceof AssertionError)
      throw new GuardianError(error.code, error.message);
    throw error;
  }
  return receipt;
}
