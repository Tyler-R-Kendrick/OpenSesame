/**
 * Single enrolled trigger open attempt for selection (TRIGGER-B).
 */

import type { SlotPlaintext } from "../crypto/slots.js";
import { openTriggerSlot } from "./enrollment-seal.js";
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
  userVerified?: boolean | undefined;
  prfOutput?: Uint8Array | null | undefined;
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
    // Both layers: the PRF output and the code (enrollment-seal.ts).
    return openTriggerSlot({
      enrolled: t,
      code: input.code,
      expect: input.expect,
      prfOutput: input.prfOutput,
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
  // A passkey-bound trigger is only ever tried with evidence from that very
  // passkey on that very origin; missing evidence is not a match.
  if (enrolled.triggerKind === "prf_and_code") {
    return (
      enrolled.credentialIdB64 !== undefined &&
      enrolled.credentialIdB64 === options.credentialIdB64 &&
      enrolled.expectedOrigin !== undefined &&
      enrolled.expectedOrigin === options.origin
    );
  }
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
