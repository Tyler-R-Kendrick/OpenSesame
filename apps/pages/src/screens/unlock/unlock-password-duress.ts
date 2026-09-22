/**
 * Password unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";

export type PasswordUnlockResult = "vault_opened" | "duress_session";

type PasswordUnlockStore = DuressContinueStore &
  Readonly<{
    unlock: (password: string) => Promise<void>;
  }>;

type PasswordDuressGateOptions = Readonly<{
  requireDurable?: boolean;
}>;
const defaultPasswordDuressGateOptions = {} satisfies PasswordDuressGateOptions;

export async function unlockWithPasswordAfterDuressGate(
  store: PasswordUnlockStore,
  password: string,
  options: PasswordDuressGateOptions = defaultPasswordDuressGateOptions,
): Promise<PasswordUnlockResult> {
  const duressOutcome = await onCompleteUnlockCodeSubmission(password, {
    requireDurable: options.requireDurable ?? true,
  });
  if (
    duressOutcome.kind === "throttled" ||
    duressOutcome.kind === "ambiguous" ||
    duressOutcome.kind === "stale_policy"
  ) {
    throw new WrongPasswordError("That password did not unlock the vault.");
  }
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      "That password did not unlock the vault.",
    );
  }
  await store.unlock(password);
  return "vault_opened";
}
