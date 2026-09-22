import type { MutableRefObject } from "react";
import { WrongPasswordError } from "../../lib/vault/crypto.js";
import type { UnlockMethodId } from "../../lib/vault/unlock-methods.js";
import { describeWebauthnError } from "../../lib/vault/unlock-methods.js";

export function applyUnlockSubmitFailure(input: {
  caught: unknown;
  awaitingSecondStep: boolean;
  activeMethod: UnlockMethodId;
  setError: (message: string | null) => void;
  setPassword: (value: string) => void;
  setPin: (value: string) => void;
  setTotp: (value: string) => void;
  totpRef: MutableRefObject<HTMLInputElement | null>;
  pinRef: MutableRefObject<HTMLInputElement | null>;
  passwordRef: MutableRefObject<HTMLInputElement | null>;
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
            (input.caught instanceof Error &&
              /invalid domain|SecurityError/i.test(input.caught.message)))
        ? describeWebauthnError(input.caught)
        : input.caught instanceof Error
          ? input.caught.message
          : "Unlock failed.",
  );
  input.setPassword("");
  input.setPin("");
  input.setTotp("");
  if (input.awaitingSecondStep) input.totpRef.current?.focus();
  else if (input.activeMethod === "pin") input.pinRef.current?.focus();
  else input.passwordRef.current?.focus();
}
