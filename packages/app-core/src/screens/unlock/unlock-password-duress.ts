/**
 * Password unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import { probeRetiredCredential } from "../../lib/retired-credentials/index.js";
import { openRetiredCredentialDecoy } from "../../lib/retired-credentials/session.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
  UNLOCK_PASSWORD_MISS,
  type UnlockDuressGateOptions,
  resolveRequireDurable,
} from "./unlock-duress-refuse.js";

export type PasswordUnlockResult =
  | "vault_opened"
  | "duress_session"
  | "retired_credential_session";

type PasswordUnlockStore = DuressContinueStore &
  Readonly<{
    unlock: (password: string) => Promise<void>;
    activeTomb?: () => string;
  }>;

export async function unlockWithPasswordAfterDuressGate(
  store: PasswordUnlockStore,
  password: string,
  options: UnlockDuressGateOptions = DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
): Promise<PasswordUnlockResult> {
  const tomb = store.activeTomb?.();
  if (tomb) {
    try {
      const trap = await probeRetiredCredential(password, tomb);
      if (store.activeTomb?.() !== tomb)
        throw new WrongPasswordError(UNLOCK_PASSWORD_MISS);
      if (trap) {
        if (trap.response === "reject")
          throw new WrongPasswordError(UNLOCK_PASSWORD_MISS);
        await openRetiredCredentialDecoy(store, trap, tomb);
        return "retired_credential_session";
      }
    } catch {
      throw new WrongPasswordError(UNLOCK_PASSWORD_MISS);
    }
  }
  const duressOutcome = await onCompleteUnlockCodeSubmission(password, {
    requireDurable: resolveRequireDurable(options),
  });
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      UNLOCK_PASSWORD_MISS,
    );
  }
  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    try {
      await store.unlock(password);
    } catch (error) {
      // One text for a miss, whichever road made it: the duress refusal below
      // says this, and an ordinary wrong password must say the same.
      throw error instanceof WrongPasswordError
        ? new WrongPasswordError(UNLOCK_PASSWORD_MISS)
        : error;
    }
    return "vault_opened";
  }
  throw new WrongPasswordError(UNLOCK_PASSWORD_MISS);
}
