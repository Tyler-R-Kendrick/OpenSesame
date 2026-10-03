/**
 * Protector unlock path — a recovery key, an age identity or an age passkey
 * (ADR 0152): complete-code duress routing before the root is spent (INV-03).
 *
 * A typed key is treated as the password is: whatever the person typed goes
 * through TRIGGER first, so a duress code entered in the key field opens the
 * decoy exactly as it would in the password field, and only a code that is not
 * a duress code reaches the capsule. An age-passkey tap carries nothing typed,
 * so it is treated as the passkey is: when a two-input trigger is armed the
 * tap only opens the root and holds it, and the complete code that follows
 * decides — decoy, or the vault — through `completePasskeyDuressCode`.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import {
  type ProtectorUnlockInput,
  protectorUnlockMiss,
} from "../../lib/vault/protection/unlock-protector-open.js";
import { maybePage } from "../../ports.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
  type UnlockDuressGateOptions,
  resolveRequireDurable,
} from "./unlock-duress-refuse.js";
import { armedTwoInputTrigger } from "./unlock-passkey-duress.js";
import {
  holdProtectorRoot,
  stashPasskeyDuressEvidence,
  toSelectOptions,
} from "./unlock-passkey-evidence.js";

export type ProtectorUnlockResult =
  | "vault_opened"
  | "needs_duress_code"
  | "duress_session";

type ProtectorUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithProtector: (input: ProtectorUnlockInput) => Promise<void>;
    probeProtector: (input: ProtectorUnlockInput) => Promise<ArrayBuffer>;
  }>;

async function tapUnlock(
  store: ProtectorUnlockStore,
  input: ProtectorUnlockInput,
): Promise<ProtectorUnlockResult> {
  if (!armedTwoInputTrigger()) {
    await store.unlockWithProtector(input);
    return "vault_opened";
  }
  holdProtectorRoot(await store.probeProtector(input), input.method);
  const origin = maybePage()?.location.origin;
  stashPasskeyDuressEvidence(
    toSelectOptions({
      userVerified: true,
      prfOutput: null,
      ...(origin === undefined ? {} : { origin }),
    }),
  );
  return "needs_duress_code";
}

export async function unlockWithProtectorAfterDuressGate(
  store: ProtectorUnlockStore,
  input: ProtectorUnlockInput,
  options: UnlockDuressGateOptions = DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
): Promise<ProtectorUnlockResult> {
  if (input.method === "agePasskey") return tapUnlock(store, input);
  const miss = protectorUnlockMiss(input.method);
  const duressOutcome = await onCompleteUnlockCodeSubmission(
    input.secret ?? "",
    { requireDurable: resolveRequireDurable(options) },
  );
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      miss,
    );
  }
  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    await store.unlockWithProtector(input);
    return "vault_opened";
  }
  throw new WrongPasswordError(miss);
}
