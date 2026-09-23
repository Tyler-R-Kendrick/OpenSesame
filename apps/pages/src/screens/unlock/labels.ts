import type { SecondStepId } from "@opensesame/app-core/lib/vault/unlock-methods.js";

/** How the unlock screen names each primary method on its tabs. */
export const METHOD_LABEL = {
  passkey: "Passkey",
  pin: "PIN",
  password: "Password",
};

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
  activeMethod: "passkey" | "pin" | "password";
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
    if (input.activeMethod === "passkey") return "Waiting for passkey…";
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
  if (input.activeMethod === "passkey") return "Unlock with passkey";
  return "Unlock";
}
