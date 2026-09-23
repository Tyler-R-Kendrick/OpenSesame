import type {
  SecondStepId,
  UnlockMethodId,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { FormEvent, MutableRefObject } from "react";
import {
  submitFirstRunUnlock,
  submitGuestUnlock,
  submitPasskeyDuressCode,
  submitPrimaryMethodUnlock,
  submitSecondStepUnlock,
} from "./unlock-form-paths.js";
import { applyUnlockSubmitFailure } from "./unlock-submit-errors.js";

type UnlockStore = Readonly<{
  createWithPasskey: (signal?: AbortSignal) => Promise<void>;
  createWithPin: (pin: string) => Promise<void>;
  create: (password: string, hint?: string) => Promise<void>;
  createGuest: (options?: { resume?: boolean }) => Promise<void>;
  cancelTotpChallenge: () => void;
  redeemRecoveryCode: (code: string) => Promise<void>;
  confirmTotp: (code: string) => Promise<void>;
  confirmRemoteCode: (code: string) => Promise<void>;
  unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
  probePasskeyPrf: (signal?: AbortSignal) => Promise<ArrayBuffer>;
  unlockWithHeldPrf: (prfOutput: ArrayBuffer) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
}>;

export async function submitUnlockForm(input: {
  event: FormEvent;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  firstRun: boolean;
  /** The guest tomb with no enrolled key: guest entry itself opens it. */
  guestKeyless: boolean;
  awaitingSecondStep: boolean;
  awaitingPasskeyDuressCode: boolean;
  setAwaitingPasskeyDuressCode: (value: boolean) => void;
  recoveryMode: boolean;
  activeMethod: UnlockMethodId;
  activeSecondStep: SecondStepId | null;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  pin: string;
  confirm: string;
  password: string;
  hint: string;
  recovery: string;
  totp: string;
  setPin: (value: string) => void;
  setConfirm: (value: string) => void;
  setPassword: (value: string) => void;
  setRecovery: (value: string) => void;
  setTotp: (value: string) => void;
  pinRef: MutableRefObject<HTMLInputElement | null>;
  passwordRef: MutableRefObject<HTMLInputElement | null>;
  totpRef: MutableRefObject<HTMLInputElement | null>;
}): Promise<void> {
  input.event.preventDefault();
  if (input.busy) return;
  input.setError(null);
  input.setBusy(true);
  try {
    if (input.firstRun) {
      await submitFirstRunUnlock(input);
    } else if (input.awaitingPasskeyDuressCode) {
      const outcome = await submitPasskeyDuressCode(input);
      if (outcome === "duress_stop") return;
      input.setAwaitingPasskeyDuressCode(false);
    } else if (input.awaitingSecondStep) {
      // A guest tomb that enrolled a gate takes the same two steps any other
      // vault does — the key first, then the code.
      const outcome = await submitSecondStepUnlock(input);
      if (outcome === "duress_stop") return;
    } else if (input.guestKeyless) {
      await submitGuestUnlock();
    } else {
      const outcome = await submitPrimaryMethodUnlock(input);
      if (outcome === "duress_stop") return;
      if (outcome === "needs_duress_code") {
        input.setAwaitingPasskeyDuressCode(true);
        return;
      }
    }
    input.setConfirm("");
  } catch (caught) {
    applyUnlockSubmitFailure({
      caught,
      awaitingSecondStep: input.awaitingSecondStep,
      activeMethod: input.activeMethod,
      setError: input.setError,
      setPassword: input.setPassword,
      setPin: input.setPin,
      setTotp: input.setTotp,
      totpRef: input.totpRef,
      pinRef: input.pinRef,
      passwordRef: input.passwordRef,
    });
  } finally {
    input.setBusy(false);
  }
}
