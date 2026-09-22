import { type RefObject, useEffect } from "react";
import { firstControl, landFocus } from "../../lib/focus.js";

/** Land the caret on the live unlock control for this ceremony. */
export function useUnlockFormFocus(args: {
  signInStage: boolean;
  showSignIn: boolean;
  formGated: boolean;
  awaitingSecondStep: boolean;
  awaitingPasskeyDuressCode?: boolean;
  guestKeyless: boolean;
  activeMethod: string;
  status: string;
  totpRef: RefObject<HTMLInputElement | null>;
  pinRef: RefObject<HTMLInputElement | null>;
  passwordRef: RefObject<HTMLInputElement | null>;
  goRef: RefObject<HTMLButtonElement | null>;
  acceptRef: RefObject<HTMLInputElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
}): void {
  const {
    signInStage,
    showSignIn,
    formGated,
    awaitingSecondStep,
    awaitingPasskeyDuressCode = false,
    guestKeyless,
    activeMethod,
    status,
    totpRef,
    pinRef,
    passwordRef,
    goRef,
    acceptRef,
    formRef,
  } = args;
  // biome-ignore lint/correctness/useExhaustiveDependencies: status is a hydrate signal
  useEffect(() => {
    if (signInStage || showSignIn || formGated) return;
    if (awaitingSecondStep) landFocus(totpRef.current);
    else if (awaitingPasskeyDuressCode) landFocus(pinRef.current);
    else if (guestKeyless || activeMethod === "passkey") {
      if (!landFocus(goRef.current) && !landFocus(acceptRef.current))
        landFocus(firstControl(formRef.current));
    } else if (activeMethod === "pin") landFocus(pinRef.current);
    else landFocus(passwordRef.current);
  }, [
    activeMethod,
    awaitingSecondStep,
    awaitingPasskeyDuressCode,
    guestKeyless,
    signInStage,
    showSignIn,
    formGated,
    status,
  ]);
}
