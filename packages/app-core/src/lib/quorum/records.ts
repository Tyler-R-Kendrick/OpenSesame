/**
 * The vault records of a circle: how the engine's documents are kept as items
 * of the two item types this capability brings (`trusted-circle` for the
 * owner, `guardian-share` for a guardian), and how they are read back.
 *
 * Both types live in `marketplace/item-types/optional/` and are installed by
 * a person, not built in (ADR 0186): they belong to this capability, not to
 * the derived records every vault carries. A record keeps what the engine
 * needs to carry on, and nothing the engine would not already publish —
 * except the two secrets, which are concealed fields: the owner's signing
 * key and a guardian's receiving key.
 */

import { isString } from "@opensesame/os-domain";
import type { FieldValues } from "@opensesame/vault-item-types";
import { fromB64url, toB64url } from "./bytes.js";
import { type Holding, parseHolding } from "./guardian.js";
import { verifySignedPolicy } from "./policy.js";
import {
  type CirclePolicy,
  type SignedPolicy,
  SignedPolicySchema,
} from "./types.js";
import { WrappedShareSchema } from "./wrap.js";

export const TRUSTED_CIRCLE_TYPE = "trusted-circle";
export const GUARDIAN_SHARE_TYPE = "guardian-share";

export type CircleState = "inviting" | "armed" | "recovering" | "retired";
export type ShareState = "held" | "approved" | "released" | "retired";

/** "3 of 5", or "2 of 3 groups: 2 of 3 family, 2 of 4 friends". */
export function ruleText(policy: CirclePolicy): string {
  const parts = policy.groups.map(
    (g) => `${g.threshold} of ${g.guardianIds.length} ${g.id}`,
  );
  const [only] = policy.groups;
  if (policy.groups.length === 1 && only) {
    return `${only.threshold} of ${only.guardianIds.length}`;
  }
  return `${policy.groupThreshold} of ${policy.groups.length} groups: ${parts.join(", ")}`;
}

function text(value: FieldValues[string] | undefined): string {
  return isString(value) ? value : "";
}

/** A `trusted-circle` item's values. The signing key is the item's secret. */
export function circleValues(input: {
  signedPolicy: SignedPolicy;
  ownerSecretKey: Uint8Array;
  state: CircleState;
}): FieldValues {
  const { policy } = input.signedPolicy;
  return {
    label: policy.label,
    collection: policy.collection,
    status: input.state,
    rule: ruleText(policy),
    guardians: policy.guardians.map((g) => g.name),
    approvalMinutes: String(Math.round(policy.approvalWindowSec / 60)),
    delayHours: String(Math.round(policy.releaseDelaySec / 3600)),
    epoch: String(policy.epoch),
    circleId: policy.circleId,
    policy: JSON.stringify(input.signedPolicy),
    ownerKey: toB64url(input.ownerSecretKey),
  };
}

export type CircleRecord = Readonly<{
  signedPolicy: SignedPolicy;
  ownerSecretKey: Uint8Array;
}>;

/** Read a circle back, re-verifying the policy against the owner key the record holds. */
export function readCircleRecord(values: FieldValues): CircleRecord {
  const signedPolicy = verifySignedPolicy(
    SignedPolicySchema.parse(JSON.parse(text(values.policy))),
  );
  return {
    signedPolicy,
    ownerSecretKey: fromB64url(text(values.ownerKey)),
  };
}

/** A `guardian-share` item's values. The wrapped share is the item's secret. */
export function shareValues(input: {
  holding: Holding;
  heldFor: string;
  receivingKey?: Uint8Array;
  state: ShareState;
}): FieldValues {
  const { signedPolicy, wrapped } = input.holding;
  return {
    owner: input.heldFor,
    circleLabel: signedPolicy.policy.label,
    status: input.state,
    epoch: String(wrapped.epoch),
    circleId: wrapped.circleId,
    guardianId: wrapped.guardianId,
    ownerKey: signedPolicy.policy.ownerKey,
    policy: JSON.stringify(signedPolicy),
    wrapped: JSON.stringify(wrapped),
    receivingKey: input.receivingKey ? toB64url(input.receivingKey) : "",
  };
}

export type ShareRecord = Readonly<{
  holding: Holding;
  receivingKey: Uint8Array | null;
}>;

/** Read a held share back; the policy must still verify under the owner key pinned in the record. */
export function readShareRecord(values: FieldValues): ShareRecord {
  const holding = parseHolding(
    {
      signedPolicy: JSON.parse(text(values.policy)),
      wrapped: WrappedShareSchema.parse(JSON.parse(text(values.wrapped))),
    },
    text(values.ownerKey),
  );
  const receiving = text(values.receivingKey);
  return {
    holding,
    receivingKey: receiving === "" ? null : fromB64url(receiving),
  };
}
