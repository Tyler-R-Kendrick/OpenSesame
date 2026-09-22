import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Approval-ceremony duress codes (TRIGGER-E / SC-APPROVAL-DURESS).
 * Denial runs before sign/mint/invoke. Never fake success. Agents cannot approve.
 */

import { TriggerAttemptPolicy } from "../trigger/attempt-policy.js";
import {
  type EnrollmentState,
  type TriggerMatch,
  disposeTriggerMatch,
  selectTrigger,
} from "../trigger/enrollment.js";
import { CodeSubmissionBuffer } from "./submission.js";

export type ApprovalOperation = "sign" | "mint" | "invoke";

export type ApprovalPrincipalKind = "human_owner" | "agent" | "peer";

export type ApprovalCeremonyInput = Readonly<{
  operation: ApprovalOperation;
  code: string;
  principalKind: ApprovalPrincipalKind;
  state: EnrollmentState;
  expectedPolicyRevision: number;
  /** Profile ids that map to approval_ceremony_code semantics. */
  approvalProfileIds?: readonly string[];
}>;

export type ApprovalCeremonyResult =
  | {
      outcome: "deny";
      reason: string;
      fakeSuccess: false;
      operationAllowed: false;
    }
  | {
      outcome: "duress";
      reason: "approval_duress_code";
      fakeSuccess: false;
      operationAllowed: false;
      match: Extract<TriggerMatch, { status: "matched" }>;
    };

/**
 * Evaluate an approval code before any sign/mint/invoke side effect.
 * A matching duress code denies the operation and returns the match for
 * STORE/AUTH to activate — never returns allow/success for that path.
 */
export async function evaluateApprovalCeremony(
  input: ApprovalCeremonyInput,
): Promise<ApprovalCeremonyResult> {
  if (input.principalKind === "agent") {
    return {
      outcome: "deny",
      reason: "agents_cannot_approve",
      fakeSuccess: false,
      operationAllowed: false,
    };
  }

  const match = await selectTrigger(input.code, input.state, {
    expectedPolicyRevision: input.expectedPolicyRevision,
  });

  if (match.status === "stale_policy") {
    return {
      outcome: "deny",
      reason: "stale_policy",
      fakeSuccess: false,
      operationAllowed: false,
    };
  }

  if (match.status === "ambiguous") {
    return {
      outcome: "deny",
      reason: "ambiguous_trigger",
      fakeSuccess: false,
      operationAllowed: false,
    };
  }

  if (match.status === "matched") {
    const allowList = input.approvalProfileIds;
    if (allowList && !allowList.includes(match.profileId)) {
      disposeTriggerMatch(match);
      return {
        outcome: "deny",
        reason: "approval_denied",
        fakeSuccess: false,
        operationAllowed: false,
      };
    }
    return {
      outcome: "duress",
      reason: "approval_duress_code",
      fakeSuccess: false,
      operationAllowed: false,
      match,
    };
  }

  // Wrong / unknown code — deny without fabricating approval success.
  return {
    outcome: "deny",
    reason: "approval_denied",
    fakeSuccess: false,
    operationAllowed: false,
  };
}

/**
 * End-to-end approval ceremony helper: buffer → complete submit → evaluate.
 * Cancel mid-entry never counts as a complete attempt.
 */
export class ApprovalCeremonySession {
  readonly buffer = new CodeSubmissionBuffer();
  readonly attempts = new TriggerAttemptPolicy();

  cancel(): void {
    this.buffer.cancel();
  }

  async submit(
    input: Omit<ApprovalCeremonyInput, "code">,
  ): Promise<ApprovalCeremonyResult> {
    const gate = this.attempts.beginCompleteAttempt();
    if (!gate.allowed) {
      return {
        outcome: "deny",
        reason: "throttled",
        fakeSuccess: false,
        operationAllowed: false,
      };
    }
    const code = this.buffer.submitComplete();
    if (!code) {
      return {
        outcome: "deny",
        reason: "incomplete_submission",
        fakeSuccess: false,
        operationAllowed: false,
      };
    }
    const result = await evaluateApprovalCeremony({ ...input, code });
    if (result.outcome === "deny" && result.reason === "approval_denied") {
      this.attempts.recordCompleteMiss();
    } else if (result.outcome === "duress") {
      this.attempts.recordCompleteHit();
    }
    return result;
  }
}
