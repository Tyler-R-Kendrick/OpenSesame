import { resumeGuestSession } from "@opensesame/app-core/lib/guest-auth.js";
import type {
  SecondStepId,
  UnlockMethodId,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  completePasskeyDuressCode,
  unlockWithPasskeyAfterDuressGate,
} from "@opensesame/app-core/screens/unlock/unlock-passkey-duress.js";
import { unlockWithPasswordAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-password-duress.js";
import { unlockWithPinAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-pin-duress.js";
import { unlockSecondStepAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-second-step-duress.js";
import type { MutableRefObject } from "react";

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
}): Promise<"duress_stop" | "done"> {
  const outcome = await unlockSecondStepAfterDuressGate({
    store: input.store,
    recoveryMode: input.recoveryMode,
    activeSecondStep: input.activeSecondStep,
    recovery: input.recovery,
    totp: input.totp,
  });
  if (input.recoveryMode) input.setRecovery("");
  else input.setTotp("");
  return outcome === "duress_session" ? "duress_stop" : "done";
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
}): Promise<"duress_stop" | "needs_duress_code" | "done"> {
  if (input.activeMethod === "passkey") {
    const controller = new AbortController();
    input.passkeyAbort.current = controller;
    try {
      const outcome = await unlockWithPasskeyAfterDuressGate(
        input.store,
        controller.signal,
      );
      if (outcome === "needs_duress_code") return "needs_duress_code";
      return outcome === "duress_session" ? "duress_stop" : "done";
    } finally {
      if (input.passkeyAbort.current === controller)
        input.passkeyAbort.current = null;
    }
  }
  if (input.activeMethod === "pin") {
    const pinOutcome = await unlockWithPinAfterDuressGate(
      input.store,
      input.pin,
    );
    input.setPin("");
    input.setConfirm("");
    return pinOutcome === "duress_session" ? "duress_stop" : "done";
  }
  const passwordOutcome = await unlockWithPasswordAfterDuressGate(
    input.store,
    input.password,
  );
  input.setPassword("");
  return passwordOutcome === "duress_session" ? "duress_stop" : "done";
}

export async function submitPasskeyDuressCode(input: {
  store: UnlockStore;
  pin: string;
  setPin: (value: string) => void;
}): Promise<"duress_stop" | "done"> {
  const outcome = await completePasskeyDuressCode(input.store, input.pin);
  input.setPin("");
  return outcome === "duress_session" ? "duress_stop" : "done";
}

export async function submitGuestUnlock(): Promise<void> {
  await resumeGuestSession();
}
