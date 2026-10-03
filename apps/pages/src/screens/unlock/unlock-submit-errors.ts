import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { describeWebauthnError } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { MutableRefObject } from "react";
import type { PendingFocus } from "./use-refocus-after-failure.js";

export function applyUnlockSubmitFailure(input: {
  caught: unknown;
  awaitingSecondStep: boolean;
  activeMethod: UnlockTabId;
  setError: (message: string | null) => void;
  setPassword: (value: string) => void;
  setProtectorSecret: (value: string) => void;
  setPin: (value: string) => void;
  setTotp: (value: string) => void;
  totpRef: MutableRefObject<HTMLInputElement | null>;
  pinRef: MutableRefObject<HTMLInputElement | null>;
  passwordRef: MutableRefObject<HTMLInputElement | null>;
  protectorRef: MutableRefObject<HTMLInputElement | null>;
  pendingFocus: PendingFocus;
}): void {
  if (
    input.caught instanceof DOMException &&
    input.caught.name === "AbortError"
  ) {
    return;
  }
  input.setError(
    input.caught instanceof WrongPasswordError
      ? input.caught.message
      : !input.awaitingSecondStep &&
          (input.activeMethod === "passkey" ||
            input.activeMethod === "agePasskey" ||
            (input.caught instanceof Error &&
              /invalid domain|SecurityError/i.test(input.caught.message)))
        ? describeWebauthnError(input.caught)
        : input.caught instanceof Error
          ? input.caught.message
          : "Unlock failed.",
  );
  input.setPassword("");
  input.setProtectorSecret("");
  input.setPin("");
  input.setTotp("");
  // Granted by useRefocusAfterFailure once the form has re-enabled.
  input.pendingFocus.current = input.awaitingSecondStep
    ? input.totpRef
    : input.activeMethod === "pin"
      ? input.pinRef
      : input.activeMethod === "recovery" || input.activeMethod === "age"
        ? input.protectorRef
        : input.passwordRef;
}
