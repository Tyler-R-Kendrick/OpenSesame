/**
 * PIN unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
  UNLOCK_PIN_MISS,
  type UnlockDuressGateOptions,
  resolveRequireDurable,
} from "./unlock-duress-refuse.js";

export type PinUnlockResult = "vault_opened" | "duress_session";

type PinUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithPin: (pin: string) => Promise<void>;
  }>;

export async function unlockWithPinAfterDuressGate(
  store: PinUnlockStore,
  pin: string,
  options: UnlockDuressGateOptions = DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
): Promise<PinUnlockResult> {
  const duressOutcome = await onCompleteUnlockCodeSubmission(pin, {
    requireDurable: resolveRequireDurable(options),
  });
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      UNLOCK_PIN_MISS,
    );
  }
  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    await store.unlockWithPin(pin);
    return "vault_opened";
  }
  throw new WrongPasswordError(UNLOCK_PIN_MISS);
}
