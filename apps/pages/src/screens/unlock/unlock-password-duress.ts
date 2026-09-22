/**
 * Password unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";

export type PasswordUnlockResult = "vault_opened" | "duress_incident";

type PasswordUnlockStore = Readonly<{
  unlock: (password: string) => Promise<void>;
}>;

export async function unlockWithPasswordAfterDuressGate(
  store: PasswordUnlockStore,
  password: string,
): Promise<PasswordUnlockResult> {
  const duressOutcome = await onCompleteUnlockCodeSubmission(password);
  if (
    duressOutcome.kind === "throttled" ||
    duressOutcome.kind === "ambiguous" ||
    duressOutcome.kind === "stale_policy"
  ) {
    throw new WrongPasswordError("That password did not unlock the vault.");
  }
  if (duressOutcome.kind === "duress") {
    return "duress_incident";
  }
  await store.unlock(password);
  return "vault_opened";
}
