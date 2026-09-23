/**
 * Password unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "@opensesame/vault-core";
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

export type PasswordUnlockResult = "vault_opened" | "duress_session";

type PasswordUnlockStore = DuressContinueStore &
  Readonly<{
    unlock: (password: string) => Promise<void>;
  }>;

export async function unlockWithPasswordAfterDuressGate(
  store: PasswordUnlockStore,
  password: string,
  options: UnlockDuressGateOptions = DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
): Promise<PasswordUnlockResult> {
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
    await store.unlock(password);
    return "vault_opened";
  }
  throw new WrongPasswordError(UNLOCK_PASSWORD_MISS);
}
