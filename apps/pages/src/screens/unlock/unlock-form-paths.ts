import { resumeGuestSession } from "@opensesame/app-core/lib/guest-auth.js";
import type {
  PasskeyProbe,
  PasskeyProbeOptions,
} from "@opensesame/app-core/lib/vault/passkey-unlock-session.js";
import type {
  PasskeyAttachment,
  PasskeyCreateOptions,
} from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-ceremony.js";
import { isPrfUnsupported } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-output.js";
import {
  type UnlockTabId,
  isProtectorUnlockMethod,
} from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { ProtectorUnlockInput } from "@opensesame/app-core/lib/vault/protection/unlock-protector-open.js";
import type { SecondStepId } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  completePasskeyDuressCode,
  unlockWithPasskeyAfterDuressGate,
} from "@opensesame/app-core/screens/unlock/unlock-passkey-duress.js";
import { unlockWithPasswordAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-password-duress.js";
import { unlockWithPinAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-pin-duress.js";
import { unlockWithProtectorAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-protector-duress.js";
import { unlockSecondStepAfterDuressGate } from "@opensesame/app-core/screens/unlock/unlock-second-step-duress.js";
import type { MutableRefObject } from "react";

type UnlockStore = Readonly<{
  createWithPasskey: (
    signal?: AbortSignal,
    options?: PasskeyCreateOptions,
  ) => Promise<void>;
  createWithPin: (pin: string) => Promise<void>;
  createGuest: (options?: { resume?: boolean }) => Promise<void>;
  cancelTotpChallenge: () => void;
  redeemRecoveryCode: (code: string) => Promise<void>;
  confirmTotp: (code: string) => Promise<void>;
  confirmRemoteCode: (code: string) => Promise<void>;
  unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
  probePasskeyCeremony: (
    options?: PasskeyProbeOptions,
  ) => Promise<PasskeyProbe>;
  unlockWithHeldPrf: (prfOutput: ArrayBuffer) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  unlockWithProtector: (input: ProtectorUnlockInput) => Promise<void>;
  probeProtector: (input: ProtectorUnlockInput) => Promise<ArrayBuffer>;
  unlockWithHeldProtectorRoot: (
    root: ArrayBuffer,
    input: Pick<ProtectorUnlockInput, "method">,
  ) => Promise<void>;
}>;

export async function submitFirstRunUnlock(input: {
  activeMethod: UnlockTabId;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  attachment?: PasskeyCreateOptions["attachment"];
  pin: string;
  confirm: string;
  setPin: (value: string) => void;
}): Promise<void> {
  if (input.activeMethod === "passkey") {
    const controller = new AbortController();
    input.passkeyAbort.current = controller;
    try {
      await input.store.createWithPasskey(controller.signal, {
        attachment: input.attachment,
      });
    } finally {
      if (input.passkeyAbort.current === controller)
        input.passkeyAbort.current = null;
    }
    return;
  }
  // A new vault is sealed with a passkey or a PIN — no master password is
  // ever created here (ADR 0180).
  if (input.activeMethod !== "pin") {
    throw new Error("Seal this device with a passkey or a PIN.");
  }
  if (input.pin !== input.confirm) {
    throw new Error("The two entries do not match.");
  }
  await input.store.createWithPin(input.pin);
  input.setPin("");
}

/**
 * A passkey seal that an authenticator cannot answer is stepped past, not
 * reported: the form moves to the next road and says so in the tray.
 */
export function stepPastUnsupported<Thrown>(
  input: {
    firstRun: boolean;
    activeMethod: UnlockTabId;
    attachment: PasskeyAttachment;
    onSealUnsupported: (kind: PasskeyAttachment) => void;
  },
  caught: Thrown,
): boolean {
  if (!input.firstRun || input.activeMethod !== "passkey") return false;
  if (!isPrfUnsupported(caught)) return false;
  input.onSealUnsupported(input.attachment);
  return true;
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

type ProtectorSubmit = {
  method: ProtectorUnlockInput["method"];
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  protectorSecret: string;
  setProtectorSecret: (value: string) => void;
};

/** A recovery key, age identity or age passkey enrolled in the manifest. */
async function submitProtectorUnlock(
  input: ProtectorSubmit,
): Promise<"duress_stop" | "needs_duress_code" | "done"> {
  const controller = new AbortController();
  input.passkeyAbort.current = controller;
  try {
    const outcome = await unlockWithProtectorAfterDuressGate(input.store, {
      method: input.method,
      secret: input.protectorSecret,
      signal: controller.signal,
    });
    if (outcome === "needs_duress_code") return "needs_duress_code";
    return outcome === "duress_session" ? "duress_stop" : "done";
  } finally {
    input.setProtectorSecret("");
    if (input.passkeyAbort.current === controller)
      input.passkeyAbort.current = null;
  }
}

export async function submitPrimaryMethodUnlock(input: {
  activeMethod: UnlockTabId;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  pin: string;
  password: string;
  protectorSecret: string;
  setPin: (value: string) => void;
  setConfirm: (value: string) => void;
  setPassword: (value: string) => void;
  setProtectorSecret: (value: string) => void;
}): Promise<"duress_stop" | "needs_duress_code" | "done"> {
  if (isProtectorUnlockMethod(input.activeMethod)) {
    return submitProtectorUnlock({ ...input, method: input.activeMethod });
  }
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
