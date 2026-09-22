import type { MutableRefObject } from "react";
import { resumeGuestSession } from "../../lib/guest-auth.js";
import type {
  SecondStepId,
  UnlockMethodId,
} from "../../lib/vault/unlock-methods.js";
import { unlockWithPasswordAfterDuressGate } from "./unlock-password-duress.js";
import { unlockWithPinAfterDuressGate } from "./unlock-pin-duress.js";

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

export async function submitFirstRunUnlock(input: {
  activeMethod: UnlockMethodId;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  pin: string;
  confirm: string;
  password: string;
  hint: string;
  setPin: (value: string) => void;
}): Promise<void> {
  if (input.activeMethod === "passkey") {
    const controller = new AbortController();
    input.passkeyAbort.current = controller;
    try {
      await input.store.createWithPasskey(controller.signal);
    } finally {
      if (input.passkeyAbort.current === controller)
        input.passkeyAbort.current = null;
    }
    return;
  }
  if (input.activeMethod === "pin") {
    if (input.pin !== input.confirm) {
      throw new Error("The two entries do not match.");
    }
    await input.store.createWithPin(input.pin);
    input.setPin("");
    return;
  }
  if (input.password !== input.confirm) {
    throw new Error("The two entries do not match.");
  }
  await input.store.create(input.password, input.hint.trim() || undefined);
}

export async function submitSecondStepUnlock(input: {
  recoveryMode: boolean;
  activeSecondStep: SecondStepId | null;
  store: UnlockStore;
  recovery: string;
  totp: string;
  setRecovery: (value: string) => void;
  setTotp: (value: string) => void;
}): Promise<void> {
  if (input.recoveryMode) {
    await input.store.redeemRecoveryCode(input.recovery);
    input.setRecovery("");
    return;
  }
  if (input.activeSecondStep === "totp") {
    await input.store.confirmTotp(input.totp);
  } else {
    await input.store.confirmRemoteCode(input.totp);
  }
  input.setTotp("");
}

export async function submitPrimaryMethodUnlock(input: {
  activeMethod: UnlockMethodId;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  pin: string;
  password: string;
  setPin: (value: string) => void;
  setConfirm: (value: string) => void;
  setPassword: (value: string) => void;
}): Promise<"duress_stop" | "done"> {
  if (input.activeMethod === "passkey") {
    const controller = new AbortController();
    input.passkeyAbort.current = controller;
    try {
      await input.store.unlockWithPasskey(controller.signal);
    } finally {
      if (input.passkeyAbort.current === controller)
        input.passkeyAbort.current = null;
    }
    return "done";
  }
  if (input.activeMethod === "pin") {
    const pinOutcome = await unlockWithPinAfterDuressGate(
      input.store,
      input.pin,
    );
    if (pinOutcome === "duress_incident") {
      input.setPin("");
      input.setConfirm("");
      return "duress_stop";
    }
    input.setPin("");
    return "done";
  }
  const passwordOutcome = await unlockWithPasswordAfterDuressGate(
    input.store,
    input.password,
  );
  if (passwordOutcome === "duress_incident") {
    input.setPassword("");
    return "duress_stop";
  }
  input.setPassword("");
  return "done";
}

export async function submitGuestUnlock(): Promise<void> {
  await resumeGuestSession();
}
