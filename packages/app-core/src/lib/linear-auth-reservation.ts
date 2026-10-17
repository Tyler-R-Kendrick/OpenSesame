import {
  type NativeOAuthBrowserPort,
  optionalNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";

/** Configuration holds this consent window across durable writes without reserving twice. */
export type LinearAuthorizationReservation = {
  browser: NativeOAuthBrowserPort | null;
  assertCurrent: () => void;
  release: () => void;
};
export function reserveLinearAuthorizationWindow(): LinearAuthorizationReservation {
  const browser = optionalNativeOAuthBrowserPort();
  const close = browser?.authorize
    ? browser.prepareAuthorization?.()
    : undefined;
  let released = false;
  let originalGuard: (() => void) | undefined;
  try {
    originalGuard = browser?.authorize
      ? browser.captureAuthorizationGuard?.()
      : undefined;
  } catch (error) {
    close?.();
    throw error;
  }
  return {
    browser,
    assertCurrent: () => {
      if (released) throw new Error("Linear sign-in was cancelled");
      originalGuard?.();
    },
    release: () => {
      if (released) return;
      released = true;
      close?.();
    },
  };
}
