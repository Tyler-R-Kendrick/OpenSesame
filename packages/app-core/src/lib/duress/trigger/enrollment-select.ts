/**
 * Complete-code trigger selection at unlock (TRIGGER-B, INV-03).
 */

import { defined } from "@opensesame/contracts";
import {
  type SlotPlaintext,
  assertTriggerCodeLength,
} from "../crypto/slots.js";
import {
  type TriggerMatchCandidate,
  bindingMatchesTrigger,
  openEnrolledTriggerPlaintext,
} from "./enrollment-match.js";
import {
  type EnrolledTrigger,
  type EnrollmentState,
  expectFrom,
} from "./enrollment-state.js";
import type { CodeTriggerKind } from "./kinds.js";

export type TriggerMatch =
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "stale_policy" }
  | { status: "throttled" }
  | {
      status: "matched";
      profileId: string;
      triggerKind: CodeTriggerKind;
      plaintext: SlotPlaintext;
      enrolled: EnrolledTrigger;
    };

export type SelectTriggerOptions = Readonly<{
  expectedPolicyRevision?: number;
  expectedKeyEpoch?: number;
  userVerified?: boolean;
  prfOutput?: Uint8Array | null;
  origin?: string;
  credentialIdB64?: string;
}>;

export async function selectTrigger(
  code: string,
  state: EnrollmentState,
  options: SelectTriggerOptions = {},
): Promise<TriggerMatch> {
  try {
    assertTriggerCodeLength(code);
  } catch {
    return { status: "none" };
  }

  if (
    options.expectedPolicyRevision !== undefined &&
    options.expectedPolicyRevision !== state.policyRevision
  ) {
    return { status: "stale_policy" };
  }
  if (
    options.expectedKeyEpoch !== undefined &&
    options.expectedKeyEpoch !== state.keyEpoch
  ) {
    return { status: "stale_policy" };
  }

  const expect = expectFrom(state);
  const matches: TriggerMatchCandidate[] = [];

  for (const t of state.triggers) {
    if (!bindingMatchesTrigger(t, options)) {
      continue;
    }
    const plaintext = await openEnrolledTriggerPlaintext({
      enrolled: t,
      code,
      expect,
      userVerified: options.userVerified,
      prfOutput: options.prfOutput,
    });
    if (plaintext) {
      matches.push({
        profileId: t.slot.profileId,
        triggerKind: t.triggerKind,
        plaintext,
        enrolled: t,
      });
    }
  }

  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) {
    for (const m of matches) {
      m.plaintext.compartmentKey.fill(0);
      m.plaintext.actionCapability?.fill(0);
    }
    return { status: "ambiguous" };
  }
  return { status: "matched", ...defined(matches[0], "match") };
}

export function disposeTriggerMatch(match: TriggerMatch): void {
  if (match.status === "matched") {
    match.plaintext.compartmentKey.fill(0);
    match.plaintext.actionCapability?.fill(0);
  }
}
