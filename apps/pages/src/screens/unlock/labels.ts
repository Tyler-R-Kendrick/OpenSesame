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

type GoVerbInput = {
  busy: boolean;
  firstRun: boolean;
  awaitingSecondStep: boolean;
  awaitingPasskeyDuressCode: boolean;
  guestUnlock: boolean;
  activeMethod: UnlockTabId;
};

function busyVerb(input: GoVerbInput): string {
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

/** The verb for opening with one method — a protector names its key. */
const UNLOCK_VERB = {
  passkey: "Unlock with passkey",
  agePasskey: "Unlock with passkey",
  recovery: "Unlock with recovery key",
  age: "Unlock with age key",
  pin: "Unlock",
  password: "Unlock",
} satisfies Record<UnlockTabId, string>;

/** Sentence for the unlock `.go` key — lives in aria-label / title, not on the face. */
export function unlockGoVerb(input: GoVerbInput): string {
  if (input.busy) return busyVerb(input);
  if (input.firstRun) {
    if (input.activeMethod === "passkey") return "Seal with passkey";
    if (input.activeMethod === "pin") return "Seal with PIN";
    return "Seal this device";
  }
  if (input.awaitingSecondStep) return "Confirm MFA";
  if (input.awaitingPasskeyDuressCode || input.guestUnlock) return "Unlock";
  return UNLOCK_VERB[input.activeMethod];
}

/** Heading for the unlock card. */
export function unlockTitle(input: {
  signIn: boolean;
  firstRun: boolean;
  awaitingSecondStep: boolean;
}): string {
  if (input.signIn) return "Sign in";
  if (input.firstRun) return "Seal this device";
  if (input.awaitingSecondStep) return "Confirm it is you";
  return "Unlock";
}
