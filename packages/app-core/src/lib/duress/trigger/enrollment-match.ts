/**
 * Single enrolled trigger open attempt for selection (TRIGGER-B).
 */

import type { SlotPlaintext } from "../crypto/slots.js";
import type { EnrolledTrigger } from "./enrollment-state.js";
import {
  type CodeTriggerKind,
  openApplicationCode,
  openVerifiedUvThenCode,
} from "./kinds.js";

export type TriggerOpenExpect = Readonly<{
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
}>;

export async function openEnrolledTriggerPlaintext(input: {
  enrolled: EnrolledTrigger;
  code: string;
  expect: TriggerOpenExpect;
  userVerified?: boolean;
  prfOutput?: Uint8Array | null;
}): Promise<SlotPlaintext | null> {
  const t = input.enrolled;
  if (t.triggerKind === "application_code") {
    return openApplicationCode({
      code: input.code,
      slot: t.slot,
      expect: input.expect,
    });
  }
  if (t.triggerKind === "verified_uv_then_code") {
    return openVerifiedUvThenCode({
      userVerified: input.userVerified === true,
      code: input.code,
      slot: t.slot,
      expect: input.expect,
    });
  }
  if (t.triggerKind === "prf_and_code") {
    if (!input.prfOutput || input.prfOutput.length < 32) {
      return null;
    }
    return openApplicationCode({
      code: input.code,
      slot: t.slot,
      expect: input.expect,
    });
  }
  return null;
}

export type TriggerMatchCandidate = Readonly<{
  profileId: string;
  triggerKind: CodeTriggerKind;
  plaintext: SlotPlaintext;
  enrolled: EnrolledTrigger;
}>;

export function bindingMatchesTrigger(
  enrolled: EnrolledTrigger,
  options: Readonly<{
    origin?: string;
    credentialIdB64?: string;
  }>,
): boolean {
  if (
    enrolled.expectedOrigin &&
    options.origin &&
    enrolled.expectedOrigin !== options.origin
  ) {
    return false;
  }
  if (
    enrolled.credentialIdB64 &&
    options.credentialIdB64 &&
    enrolled.credentialIdB64 !== options.credentialIdB64
  ) {
    return false;
  }
  return true;
}
