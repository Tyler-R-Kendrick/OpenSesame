import type { SecondStepId } from "../../lib/vault/unlock-methods.js";

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
