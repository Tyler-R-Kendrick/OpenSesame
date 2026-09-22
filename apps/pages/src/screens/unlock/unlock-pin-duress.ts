/**
 * PIN unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";

export type PinUnlockResult = "vault_opened" | "duress_session";

type PinUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithPin: (pin: string) => Promise<void>;
  }>;

export async function unlockWithPinAfterDuressGate(
  store: PinUnlockStore,
  pin: string,
  options: { requireDurable?: boolean } = {},
): Promise<PinUnlockResult> {
  const duressOutcome = await onCompleteUnlockCodeSubmission(pin, {
    requireDurable: options.requireDurable ?? true,
  });
  if (
    duressOutcome.kind === "throttled" ||
    duressOutcome.kind === "ambiguous" ||
    duressOutcome.kind === "stale_policy"
  ) {
    throw new WrongPasswordError("That PIN did not unlock the vault.");
  }
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      store,
      duressOutcome.match.plaintext.presentation,
      "That PIN did not unlock the vault.",
    );
  }
  await store.unlockWithPin(pin);
  return "vault_opened";
}
