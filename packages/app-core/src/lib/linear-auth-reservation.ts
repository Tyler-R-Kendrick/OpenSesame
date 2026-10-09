import {
  type NativeOAuthBrowserPort,
  optionalNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";

/** Configuration holds this consent window across durable writes without reserving twice. */
export type LinearAuthorizationReservation = {
  browser: NativeOAuthBrowserPort | null;
  release: () => void;
};
export function reserveLinearAuthorizationWindow(): LinearAuthorizationReservation {
  const browser = optionalNativeOAuthBrowserPort();
  const close = browser?.authorize
    ? browser.prepareAuthorization?.()
    : undefined;
  let released = false;
  return {
    browser,
    release: () => {
      if (released) return;
      released = true;
      close?.();
    },
  };
}
