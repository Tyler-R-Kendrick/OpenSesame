/**
 * PIN unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";

export type PinUnlockResult = "vault_opened" | "duress_incident";

type PinUnlockStore = Readonly<{
  unlockWithPin: (pin: string) => Promise<void>;
}>;

export async function unlockWithPinAfterDuressGate(
  store: PinUnlockStore,
  pin: string,
): Promise<PinUnlockResult> {
  const duressOutcome = await onCompleteUnlockCodeSubmission(pin);
  if (
    duressOutcome.kind === "throttled" ||
    duressOutcome.kind === "ambiguous" ||
    duressOutcome.kind === "stale_policy"
  ) {
    throw new WrongPasswordError("That PIN did not unlock the vault.");
  }
  if (duressOutcome.kind === "duress") {
    return "duress_incident";
  }
  await store.unlockWithPin(pin);
  return "vault_opened";
}
