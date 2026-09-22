/**
 * Immutable encryption plans and the digest a human approval binds to
 * (B09, SB-049). A plan lists every recipient in every group, the group
 * threshold, and the selection policy; the digest changes when any of them
 * does, so a swapped recipient or config invalidates a prior approval.
 */

import type { SopsFormat } from "./document.js";
import { SopsError } from "./errors.js";
import { parseAgeRecipient } from "./keys/age.js";
import type { WrapTarget } from "./keys/groups.js";
import { MAX_KEY_GROUPS, MAX_RECIPIENT_ENTRIES } from "./limits.js";
import {
  DEFAULT_POLICY,
  type SopsPolicy,
  assertPolicyValid,
} from "./selectors.js";

export type EncryptionPlan = {
  format: SopsFormat;
  groups: readonly (readonly WrapTarget[])[];
  /** 0 selects upstream's default: every group. */
  shamirThreshold: number;
  policy: SopsPolicy;
};

export type OperationScope = {
  operationId: string;
  documentGeneration: number;
  sessionGeneration: number;
  vaultScope: string | null;
};

export type ExecutionPermit = {
  scope: OperationScope;
  approvedPlanDigest: string;
  network: "forbidden" | "explicit-providers-only";
};

/** Build a plan from plain recipient lists; validates every recipient. */
export function planFromRecipients(input: {
  format: SopsFormat;
  groups: readonly (readonly string[])[];
  shamirThreshold?: number;
  policy?: Partial<SopsPolicy>;
}): EncryptionPlan {
  const groups = input.groups.map((group) =>
    group.map((line) => ({
      kind: "age" as const,
      recipient: parseAgeRecipient(line),
    })),
  );
  const plan: EncryptionPlan = {
    format: input.format,
    groups,
    shamirThreshold: input.shamirThreshold ?? 0,
    policy: { ...DEFAULT_POLICY, ...input.policy },
  };
  validatePlan(plan);
  return plan;
}

export function validatePlan(plan: EncryptionPlan): void {
  if (plan.groups.length === 0) {
    throw new SopsError(
      "invalid_recipient",
      "At least one key group is required.",
    );
  }
  if (plan.groups.length > MAX_KEY_GROUPS) {
    throw new SopsError("resource_limit", "Too many key groups.");
  }
  let total = 0;
  for (const group of plan.groups) {
    if (group.length === 0)
      throw new SopsError(
        "invalid_recipient",
        "A key group has no recipients.",
      );
    const seen = new Set<string>();
    for (const target of group) {
      const id =
        target.kind === "age"
          ? parseAgeRecipient(target.recipient)
          : `${target.kind}:${target.template.kind === "age" ? "" : target.template.locator}`;
      if (seen.has(id))
        throw new SopsError(
          "invalid_recipient",
          "A key group repeats a recipient.",
        );
      seen.add(id);
      total += 1;
    }
  }
  if (total > MAX_RECIPIENT_ENTRIES) {
    throw new SopsError("resource_limit", "Too many recipients.");
  }
  if (plan.groups.length > 1) {
    const threshold = plan.shamirThreshold;
    if (
      !Number.isInteger(threshold) ||
      threshold < 0 ||
      threshold > plan.groups.length ||
      threshold === 1
    ) {
      throw new SopsError(
        "unauthorized_policy",
        "shamir_threshold must be 0 or between 2 and the number of groups.",
      );
    }
  }
  assertPolicyValid(plan.policy);
}

function canonical(plan: EncryptionPlan): string {
  return JSON.stringify({
    format: plan.format,
    groups: plan.groups.map((group) =>
      group.map((target) =>
        target.kind === "age"
          ? ["age", target.recipient]
          : [
              target.kind,
              target.template.kind === "age" ? "" : target.template.locator,
            ],
      ),
    ),
    shamirThreshold: plan.shamirThreshold,
    policy: [
      plan.policy.unencryptedSuffix,
      plan.policy.encryptedSuffix,
      plan.policy.unencryptedRegex,
      plan.policy.encryptedRegex,
      plan.policy.unencryptedCommentRegex,
      plan.policy.encryptedCommentRegex,
      plan.policy.macOnlyEncrypted,
    ],
  });
}

/** SHA-256 hex of the canonical plan; what an approval binds to. */
export async function planDigest(plan: EncryptionPlan): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(plan));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertPermitted(
  plan: EncryptionPlan,
  permit: ExecutionPermit,
): Promise<void> {
  const digest = await planDigest(plan);
  if (digest !== permit.approvedPlanDigest) {
    throw new SopsError(
      "unauthorized_policy",
      "The plan differs from the one approved.",
    );
  }
}

/** The number of groups a plan will require upstream (0 → all). */
export function planRequiredGroups(plan: EncryptionPlan): number {
  if (plan.groups.length <= 1) return 1;
  return plan.shamirThreshold === 0 ? plan.groups.length : plan.shamirThreshold;
}
