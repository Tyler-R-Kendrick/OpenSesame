/**
 * Trigger kind guarantees (TRIGGER-C).
 * Labels are honest: UV ≠ biometrics; PRF+code requires both inputs.
 */

import {
  type PrfAndCodeEnvelope,
  type SealedSlot,
  type SlotPlaintext,
  openPrfAndCode,
  openProfileSlot,
} from "../crypto/slots.js";
import { assertTriggerCodeLength } from "./codes.js";

export type CodeTriggerKind =
  | "application_code"
  | "verified_uv_then_code"
  | "prf_and_code";

export type TriggerKindGuarantee = Readonly<{
  kind: CodeTriggerKind;
  /** Ordered inputs required on every admitted path. */
  requiredInputs: readonly string[];
  /** Product must never equate UV with biometric modality. */
  uvEqualsBiometrics: false;
  /** Whether PRF output is cryptographically required. */
  prfRequired: boolean;
  /** Human-readable honest guarantee string for UI/settings. */
  guarantee: string;
}>;

const GUARANTEES = {
  application_code: {
    kind: "application_code",
    requiredInputs: ["code"],
    uvEqualsBiometrics: false,
    prfRequired: false,
    guarantee:
      "Complete application code alone opens the enrolled slot. No WebAuthn UV or PRF claimed.",
  },
  verified_uv_then_code: {
    kind: "verified_uv_then_code",
    requiredInputs: ["verified_uv", "code"],
    uvEqualsBiometrics: false,
    prfRequired: false,
    guarantee:
      "User verification bit then complete code. UV asserts verification, not biometric modality. UV alone never releases the compartment key.",
  },
  prf_and_code: {
    kind: "prf_and_code",
    requiredInputs: ["prf", "code"],
    uvEqualsBiometrics: false,
    prfRequired: true,
    guarantee:
      "PRF output and complete code are both required. Either input alone yields nothing.",
  },
} as const satisfies Record<CodeTriggerKind, TriggerKindGuarantee>;

export function describeTriggerKind(
  kind: CodeTriggerKind,
): TriggerKindGuarantee {
  return GUARANTEES[kind];
}

export function assertCapabilitiesForKind(
  kind: CodeTriggerKind,
  caps: {
    prfAvailable: boolean;
    userVerificationAvailable: boolean;
  },
): void {
  const g = GUARANTEES[kind];
  if (g.prfRequired && !caps.prfAvailable) {
    throw new Error("unsupported_factor: PRF unavailable for prf_and_code");
  }
  if (kind === "verified_uv_then_code" && !caps.userVerificationAvailable) {
    throw new Error(
      "unsupported_factor: user verification unavailable for verified_uv_then_code",
    );
  }
}

export type SlotExpect = Readonly<{
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
}>;

/** Code-only open — used after complete submission for application_code. */
export async function openApplicationCode(input: {
  code: string;
  slot: SealedSlot;
  expect: SlotExpect;
}): Promise<SlotPlaintext | null> {
  return openProfileSlot(input.code, input.slot, input.expect);
}

/**
 * UV gate then code. UV alone returns null; missing UV returns null.
 * Does not claim biometric strength.
 */
export async function openVerifiedUvThenCode(input: {
  userVerified: boolean;
  /** Explicit: biometrics are not inferred from UV. Callers must omit or pass false. */
  treatUvAsBiometrics?: boolean;
  code: string;
  slot: SealedSlot;
  expect: SlotExpect;
}): Promise<SlotPlaintext | null> {
  if (input.treatUvAsBiometrics) {
    throw new Error("unsupported_factor: UV must not be treated as biometrics");
  }
  if (!input.userVerified) return null;
  try {
    assertTriggerCodeLength(input.code);
  } catch {
    return null;
  }
  return openProfileSlot(input.code, input.slot, input.expect);
}

/** Two-input open; either missing input → null (AT-020/021/022 class). */
export async function openPrfAndCodeTrigger(input: {
  prfOutput: Uint8Array | null;
  code: string | null;
  envelope: PrfAndCodeEnvelope;
}): Promise<Uint8Array | null> {
  return openPrfAndCode(input);
}
