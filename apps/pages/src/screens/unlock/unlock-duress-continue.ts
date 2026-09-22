/**
 * After a matched duress trigger: leave unlock looking like a normal session
 * for open presentations, or like a wrong secret for locked ones (INV-03).
 */

import type { PresentationClass } from "../../lib/duress/access/context.js";
import { WrongPasswordError } from "../../lib/vault/crypto.js";

export type DuressContinueStore = Readonly<{
  createGuest: (options?: { resume?: boolean }) => Promise<void>;
  cancelTotpChallenge?: () => void;
}>;

function presentationOf(value: string): PresentationClass {
  if (
    value === "normal" ||
    value === "restricted" ||
    value === "decoy" ||
    value === "locked" ||
    value === "unchanged"
  ) {
    return value;
  }
  return "restricted";
}

/**
 * Locked / unchanged: fail like a wrong secret (incident already journaled).
 * Decoy / restricted / normal: open the isolated guest tomb so the shell
 * leaves UnlockScreen without releasing the protected root.
 */
export async function continueAfterDuressMatch(
  store: DuressContinueStore,
  presentationRaw: string,
  wrongSecretMessage: string,
): Promise<"duress_session"> {
  store.cancelTotpChallenge?.();
  const presentation = presentationOf(presentationRaw);
  if (presentation === "locked" || presentation === "unchanged") {
    throw new WrongPasswordError(wrongSecretMessage);
  }
  await store.createGuest();
  return "duress_session";
}
