/**
 * The circle's policy: its checks, its digest, its owner signature, and the
 * one question the rest of the module asks of it — does this set of
 * guardians satisfy it?
 *
 * A guardian is a person, not a key. A backup key adds availability to one
 * guardian and never a second vote, so everything here counts guardian ids,
 * and a credential may belong to exactly one guardian.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { fromB64url, toB64url } from "./bytes.js";
import { canonicalize, frame, framedDigest } from "./canonical.js";
import {
  type CirclePolicy,
  CirclePolicySchema,
  type Guardian,
  type GuardianCredential,
  type SignedPolicy,
  SignedPolicySchema,
} from "./types.js";

const POLICY_PURPOSE = "opensesame:quorum-policy:v1";
const SIGNATURE_PURPOSE = "opensesame:quorum-policy-signature:v1";

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export function policyDigest(policy: CirclePolicy): string {
  return framedDigest(POLICY_PURPOSE, [canonicalize(policy)]);
}

function signedBytes(digest: string): Uint8Array {
  return frame([SIGNATURE_PURPOSE, digest]);
}

export function signPolicy(
  policy: CirclePolicy,
  ownerSecretKey: Uint8Array,
): SignedPolicy {
  const checked = CirclePolicySchema.parse(policy);
  assertPolicySound(checked);
  const digest = policyDigest(checked);
  return {
    policy: checked,
    digest,
    signature: toB64url(ed25519.sign(signedBytes(digest), ownerSecretKey)),
  };
}

/**
 * A policy as received: well-formed, sound, and signed by the owner key it
 * names. A guardian pins that key when they accept the invitation, so a
 * policy signed by another key is not the owner's.
 */
export function verifySignedPolicy(
  input: BoundaryValue,
  pinnedOwnerKey?: string,
): SignedPolicy {
  const signed = SignedPolicySchema.parse(input);
  assertPolicySound(signed.policy);
  if (policyDigest(signed.policy) !== signed.digest) {
    throw new PolicyError(
      "digest_mismatch",
      "the policy does not match its digest",
    );
  }
  if (
    pinnedOwnerKey !== undefined &&
    signed.policy.ownerKey !== pinnedOwnerKey
  ) {
    throw new PolicyError(
      "owner_key_changed",
      "the policy is signed by a different owner key",
    );
  }
  const ok = ed25519.verify(
    fromB64url(signed.signature),
    signedBytes(signed.digest),
    fromB64url(signed.policy.ownerKey),
  );
  if (!ok)
    throw new PolicyError(
      "bad_signature",
      "the owner signature does not verify",
    );
  return signed;
}

export function guardianById(
  policy: CirclePolicy,
  guardianId: string,
): Guardian | undefined {
  return policy.guardians.find((g) => g.id === guardianId);
}

export function credentialOf(
  guardian: Guardian,
  credentialId: string,
): GuardianCredential | undefined {
  return guardian.credentials.find((c) => c.credentialId === credentialId);
}

/** Whether `origin` is one the policy accepts a WebAuthn assertion from. */
export function originAllowed(policy: CirclePolicy, origin: string): boolean {
  return policy.origins.includes(origin);
}

/** Does this set of guardians meet the group threshold of member thresholds? */
export function satisfies(
  policy: CirclePolicy,
  guardianIds: ReadonlySet<string>,
): boolean {
  const met = policy.groups.filter(
    (group) =>
      group.guardianIds.filter((id) => guardianIds.has(id)).length >=
      group.threshold,
  );
  return met.length >= policy.groupThreshold;
}

function hostOf(origin: string): string {
  return new URL(origin).hostname;
}

function checkGraph(policy: CirclePolicy): void {
  const ids = policy.guardians.map((g) => g.id);
  if (new Set(ids).size !== ids.length) {
    throw new PolicyError("duplicate_guardian", "guardian ids must be unique");
  }
  const members = policy.groups.flatMap((g) => g.guardianIds);
  if (new Set(members).size !== members.length) {
    throw new PolicyError(
      "guardian_in_two_groups",
      "a guardian holds one share, so sits in one group",
    );
  }
  if (
    members.some((id) => !ids.includes(id)) ||
    ids.some((id) => !members.includes(id))
  ) {
    throw new PolicyError(
      "group_membership",
      "every guardian is in exactly one group",
    );
  }
  if (policy.groupThreshold > policy.groups.length) {
    throw new PolicyError(
      "group_threshold",
      "the group threshold exceeds the group count",
    );
  }
  for (const group of policy.groups) {
    if (group.threshold > group.guardianIds.length) {
      throw new PolicyError(
        "member_threshold",
        `group ${group.id} needs more guardians than it has`,
      );
    }
    if (group.threshold === 1 && group.guardianIds.length > 1) {
      throw new PolicyError(
        "member_threshold_one",
        "a 1-of-N group adds no security: use one guardian",
      );
    }
  }
}

function checkCredentials(policy: CirclePolicy): void {
  const seen = new Set<string>();
  for (const guardian of policy.guardians) {
    for (const credential of guardian.credentials) {
      if (seen.has(credential.credentialId)) {
        throw new PolicyError(
          "shared_credential",
          "a credential belongs to one guardian only",
        );
      }
      seen.add(credential.credentialId);
    }
    const protects = policy.operations.includes("recover-collection");
    if (protects && !guardian.credentials.some((c) => c.prf)) {
      throw new PolicyError(
        "no_prf",
        `${guardian.name} has no key that can protect a share (WebAuthn PRF)`,
      );
    }
  }
  // A circle that holds shares commits to each; one that only authorizes
  // actions holds none, and says so by committing to nothing.
  const committed = Object.keys(policy.shareCommitments).sort();
  const expected = policy.operations.includes("recover-collection")
    ? policy.guardians.map((g) => g.id).sort()
    : [];
  if (committed.join() !== expected.join()) {
    throw new PolicyError(
      "commitments",
      "a share commitment is needed for each guardian of a recovering circle, and for no other",
    );
  }
}

function checkOriginsAndTime(policy: CirclePolicy): void {
  for (const origin of policy.origins) {
    const host = hostOf(origin);
    if (host !== policy.rpId && !host.endsWith(`.${policy.rpId}`)) {
      throw new PolicyError(
        "rp_id",
        `${origin} is not under the RP ID ${policy.rpId}`,
      );
    }
  }
  if (policy.approvalWindowSec > policy.requestLifetimeSec) {
    throw new PolicyError(
      "lifetime",
      "the approval window outlasts the request",
    );
  }
  if (policy.releaseDelaySec >= policy.requestLifetimeSec) {
    throw new PolicyError(
      "lifetime",
      "the request would expire before any share could be released",
    );
  }
}

function checkChain(policy: CirclePolicy): void {
  const { epoch, supersedes } = policy;
  if (epoch === 1 && supersedes) {
    throw new PolicyError("chain", "the first epoch replaces nothing");
  }
  if (epoch > 1 && supersedes?.epoch !== epoch - 1) {
    throw new PolicyError(
      "chain",
      "a later epoch must name the epoch before it",
    );
  }
}

/** Structural soundness: a failure here means the policy cannot be used. */
export function assertPolicySound(policy: CirclePolicy): void {
  checkChain(policy);
  checkGraph(policy);
  checkCredentials(policy);
  checkOriginsAndTime(policy);
}

export type PolicyWarning = Readonly<{ code: string; message: string }>;

/** Advisories: legal policies a careful owner would still want to hear about. */
export function policyWarnings(policy: CirclePolicy): PolicyWarning[] {
  const warnings: PolicyWarning[] = [];
  if (policy.guardians.length === 1) {
    warnings.push({
      code: "single_guardian",
      message:
        "One person holds the whole recovery key. A quorum needs at least 2 of 3.",
    });
  }
  for (const group of policy.groups) {
    if (
      group.guardianIds.length > 1 &&
      group.threshold === group.guardianIds.length
    ) {
      warnings.push({
        code: "unanimity",
        message: `Group ${group.id} needs everyone: one refusal or one lost key blocks recovery.`,
      });
    }
  }
  if (policy.releaseDelaySec === 0) {
    warnings.push({
      code: "no_delay",
      message: "With no delay you have no time to notice and cancel a request.",
    });
  }
  if (!policy.requireUserVerification) {
    warnings.push({
      code: "no_user_verification",
      message: "A key can approve by touch alone, without a PIN or biometric.",
    });
  }
  if (policy.groupThreshold === 1) {
    for (const group of policy.groups) {
      const byDomain = new Map<string, number>();
      for (const id of group.guardianIds) {
        const domain = guardianById(policy, id)?.custodyDomain ?? id;
        byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
      }
      if ([...byDomain.values()].some((n) => n >= group.threshold)) {
        warnings.push({
          code: "quorum_in_one_domain",
          message: `Group ${group.id} could reach its threshold within one household or shared account.`,
        });
      }
    }
  }
  return warnings;
}
