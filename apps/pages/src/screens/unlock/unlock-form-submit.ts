import type { FormEvent, MutableRefObject } from "react";
import type {
  SecondStepId,
  UnlockMethodId,
} from "../../lib/vault/unlock-methods.js";
import {
  submitFirstRunUnlock,
  submitGuestUnlock,
  submitPrimaryMethodUnlock,
  submitSecondStepUnlock,
} from "./unlock-form-paths.js";
import { applyUnlockSubmitFailure } from "./unlock-submit-errors.js";

type UnlockStore = Readonly<{
  createWithPasskey: (signal?: AbortSignal) => Promise<void>;
  createWithPin: (pin: string) => Promise<void>;
  create: (password: string, hint?: string) => Promise<void>;
  redeemRecoveryCode: (code: string) => Promise<void>;
  confirmTotp: (code: string) => Promise<void>;
  confirmRemoteCode: (code: string) => Promise<void>;
  unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
}>;

export async function submitUnlockForm(input: {
  event: FormEvent;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  firstRun: boolean;
  guestUnlock: boolean;
  awaitingSecondStep: boolean;
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
    } else if (input.guestUnlock) {
      await submitGuestUnlock();
    } else if (input.awaitingSecondStep) {
      await submitSecondStepUnlock(input);
    } else {
      const outcome = await submitPrimaryMethodUnlock(input);
      if (outcome === "duress_stop") return;
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
