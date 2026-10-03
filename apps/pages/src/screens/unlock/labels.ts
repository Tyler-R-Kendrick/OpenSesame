import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { SecondStepId } from "@opensesame/app-core/lib/vault/unlock-methods.js";

/**
 * How the unlock screen names each method on its tabs: the header's own wraps,
 * and the manifest's protectors that open the vault (ADR 0152).
 */
export const METHOD_LABEL = {
  passkey: "Passkey",
  pin: "PIN",
  password: "Password",
  agePasskey: "Age passkey",
  age: "Age key",
  recovery: "Recovery key",
} satisfies Record<UnlockTabId, string>;

/** The methods that open the vault by a typed key rather than a ceremony. */
export function isTypedProtector(method: UnlockTabId): boolean {
  return method === "recovery" || method === "age";
}

/** The methods that open by an authenticator prompt. */
export function isCeremonyMethod(method: UnlockTabId): boolean {
  return method === "passkey" || method === "agePasskey";
}

/** How it names each second step. */
export const SECOND_STEP_LABEL = {
  totp: "Authenticator",
  email: "Email",
  sms: "Text",
} satisfies Record<SecondStepId, string>;

/** A code by email or text may be asked for again after this long. */
export const RESEND_COOLDOWN_MS = 30_000;

/** Sentence for the unlock `.go` key — lives in aria-label / title, not on the face. */
export function unlockGoVerb(input: {
  busy: boolean;
  firstRun: boolean;
  awaitingSecondStep: boolean;
  awaitingPasskeyDuressCode: boolean;
  guestUnlock: boolean;
  activeMethod: UnlockTabId;
}): string {
  if (input.busy) {
    if (input.firstRun) {
      if (input.activeMethod === "passkey") return "Waiting for passkey…";
      if (input.activeMethod === "pin") return "Sealing…";
      return "Deriving key…";
    }
    if (input.awaitingSecondStep || input.awaitingPasskeyDuressCode) {
      return "Checking code…";
    }
    if (isCeremonyMethod(input.activeMethod)) return "Waiting for passkey…";
    return "Unlocking…";
  }
  if (input.firstRun) {
    if (input.activeMethod === "passkey") return "Seal with passkey";
    if (input.activeMethod === "pin") return "Seal with PIN";
    return "Seal this device";
  }
  if (input.awaitingSecondStep) return "Confirm MFA";
  if (input.awaitingPasskeyDuressCode) return "Unlock";
  if (input.guestUnlock) return "Unlock";
  if (isCeremonyMethod(input.activeMethod)) return "Unlock with passkey";
  if (input.activeMethod === "recovery") return "Unlock with recovery key";
  if (input.activeMethod === "age") return "Unlock with age key";
  return "Unlock";
}
