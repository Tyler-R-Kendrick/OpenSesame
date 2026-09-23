/**
 * Second-step unlock (TOTP / remote / recovery): duress complete-code gate
 * before activating a parked primary key (INV-03).
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import type { SecondStepId } from "../../lib/vault/unlock-methods.js";
import { onCompleteUnlockCodeSubmission } from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  takePasskeyDuressEvidence,
  toSelectOptions,
} from "./unlock-passkey-evidence.js";

export type SecondStepUnlockResult = "vault_opened" | "duress_session";

type SecondStepUnlockStore = DuressContinueStore &
  Readonly<{
    redeemRecoveryCode: (code: string) => Promise<void>;
    confirmTotp: (code: string) => Promise<void>;
    confirmRemoteCode: (code: string) => Promise<void>;
  }>;

export async function unlockSecondStepAfterDuressGate(input: {
  store: SecondStepUnlockStore;
  recoveryMode: boolean;
  activeSecondStep: SecondStepId | null;
  recovery: string;
  totp: string;
}): Promise<SecondStepUnlockResult> {
  const code = input.recoveryMode ? input.recovery : input.totp;
  const wrong = input.recoveryMode
    ? "That recovery code is not valid."
    : "That authenticator code is not valid.";

  const evidence = takePasskeyDuressEvidence();
  const duressOutcome =
    evidence === null
      ? await onCompleteUnlockCodeSubmission(code)
      : await onCompleteUnlockCodeSubmission(code, {
          select: toSelectOptions(evidence),
        });
  if (duressOutcome.kind === "duress") {
    return continueAfterDuressMatch(
      input.store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      wrong,
    );
  }
  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    if (input.recoveryMode) {
      await input.store.redeemRecoveryCode(input.recovery);
      return "vault_opened";
    }
    if (input.activeSecondStep === "totp") {
      await input.store.confirmTotp(input.totp);
    } else {
      await input.store.confirmRemoteCode(input.totp);
    }
    return "vault_opened";
  }
  throw new WrongPasswordError(wrong);
}
