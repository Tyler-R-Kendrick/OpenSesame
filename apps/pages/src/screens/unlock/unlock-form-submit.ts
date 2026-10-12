import type {
  PasskeyProbe,
  PasskeyProbeOptions,
} from "@opensesame/app-core/lib/vault/passkey-unlock-session.js";
import type {
  PasskeyAttachment,
  PasskeyCreateOptions,
} from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-ceremony.js";
import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type { ProtectorUnlockInput } from "@opensesame/app-core/lib/vault/protection/unlock-protector-open.js";
import type { SecondStepId } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { FormEvent, MutableRefObject } from "react";
import {
  stepPastUnsupported,
  submitFirstRunUnlock,
  submitGuestUnlock,
  submitPasskeyDuressCode,
  submitPrimaryMethodUnlock,
  submitSecondStepUnlock,
} from "./unlock-form-paths.js";
import { applyUnlockSubmitFailure } from "./unlock-submit-errors.js";
import type { PendingFocus } from "./use-refocus-after-failure.js";

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
  activeMethod: UnlockTabId;
  activeSecondStep: SecondStepId | null;
  store: UnlockStore;
  passkeyAbort: MutableRefObject<AbortController | null>;
  /** The kind of authenticator a first-run passkey seal asks for. */
  attachment: PasskeyAttachment;
  onSealUnsupported: (kind: PasskeyAttachment) => void;
  pin: string;
  confirm: string;
  password: string;
  protectorSecret: string;
  recovery: string;
  totp: string;
  setPin: (value: string) => void;
  setConfirm: (value: string) => void;
  setPassword: (value: string) => void;
  setProtectorSecret: (value: string) => void;
  setRecovery: (value: string) => void;
  setTotp: (value: string) => void;
  pinRef: MutableRefObject<HTMLInputElement | null>;
  passwordRef: MutableRefObject<HTMLInputElement | null>;
  protectorRef: MutableRefObject<HTMLInputElement | null>;
  totpRef: MutableRefObject<HTMLInputElement | null>;
  pendingFocus: PendingFocus;
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
    if (stepPastUnsupported(input, caught)) return;
    applyUnlockSubmitFailure({
      caught,
      awaitingSecondStep: input.awaitingSecondStep,
      activeMethod: input.activeMethod,
      setError: input.setError,
      setPassword: input.setPassword,
      setProtectorSecret: input.setProtectorSecret,
      setPin: input.setPin,
      setTotp: input.setTotp,
      totpRef: input.totpRef,
      pinRef: input.pinRef,
      passwordRef: input.passwordRef,
      protectorRef: input.protectorRef,
      pendingFocus: input.pendingFocus,
    });
  } finally {
    input.setBusy(false);
  }
}
