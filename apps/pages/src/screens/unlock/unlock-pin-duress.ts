/**
 * PIN unlock path: complete-code duress routing before vault unwrap (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import {
  type UnlockDuressOutcome,
  onCompleteUnlockCodeSubmission,
} from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";

export type PinUnlockResult = "vault_opened" | "duress_session";

type PinUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithPin: (pin: string) => Promise<void>;
  }>;

type PinDuressGateOptions = Readonly<{
  requireDurable?: boolean;
  submit?: (
    code: string,
    options: { requireDurable?: boolean },
  ) => Promise<UnlockDuressOutcome>;
}>;
const defaultPinDuressGateOptions = {} satisfies PinDuressGateOptions;

export async function unlockWithPinAfterDuressGate(
  store: PinUnlockStore,
  pin: string,
  options: PinDuressGateOptions = defaultPinDuressGateOptions,
): Promise<PinUnlockResult> {
  const submit = options.submit ?? onCompleteUnlockCodeSubmission;
  const requireDurable = options.requireDurable ?? true;
  const duressOutcome = await submit(pin, { requireDurable });
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
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      "That PIN did not unlock the vault.",
    );
  }
  await store.unlockWithPin(pin);
  return "vault_opened";
}
