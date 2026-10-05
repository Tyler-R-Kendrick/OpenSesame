/**
 * What the unlock form tells the help key its gate draws (ADR 0165): which of
 * its screens it is, and the controls a tutorial points at, each in one place
 * so the form itself keeps a line for them and no more.
 *
 * The form is several screens in one component, and a tutorial is scoped to
 * the one whose controls it points at, so a tour of the password field is not
 * offered where only a passkey tab is drawn, nor where only providers are:
 *
 *  - `/unlock/signin` — first run's way in, the provider panel and the local
 *    seal beside it;
 *  - `/unlock/form` — the key ceremony with a typed key: password, PIN, or a
 *    recovery or age key;
 *  - `/unlock/passkey` — the key ceremony with the passkey tab picked;
 *  - `/unlock` — anything else (the second step, the user menu's sign-in, a
 *    passkey that opens an age key): written help only, no tour.
 */

import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { useSupportRoute } from "../../tutorial/session.js";

const TYPED = new Set(["password", "pin", "recovery", "age"]);

/**
 * `method` is the method the key ceremony is showing, or empty while the
 * second step, a duress code or a missing key is the screen instead.
 */
export function unlockRoute(
  signInStage: boolean,
  showSignIn: boolean,
  method: string,
): GuideRouteId {
  if (signInStage) return "/unlock/signin";
  if (showSignIn) return "/unlock";
  if (method === "passkey") return "/unlock/passkey";
  return TYPED.has(method) ? "/unlock/form" : "/unlock";
}

export function useUnlockRoute(
  signInStage: boolean,
  showSignIn: boolean,
  method: string,
): void {
  useSupportRoute(unlockRoute(signInStage, showSignIn, method));
}

export function useUnlockTargets() {
  return {
    submitRef: useGuideTarget<HTMLButtonElement>("unlock.submit"),
    secretRef: useGuideTarget<HTMLInputElement>("unlock.secret"),
    passkeyRef: useGuideTarget<HTMLButtonElement>("unlock.passkey"),
    setupRef: useGuideTarget<HTMLButtonElement>("unlock.setup"),
    methodsRef: useGuideTarget<HTMLDivElement>("unlock.methods"),
  };
}
