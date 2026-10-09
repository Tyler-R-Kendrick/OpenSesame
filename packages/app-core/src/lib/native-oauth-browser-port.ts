/** Browser navigation and popup authorization are installed by the optional connector runtime. */
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";

export type NativeOAuthDeviceConsentRequest = {
  verificationUri: string;
  userCode: string;
  state: string;
  expiresAt: number;
};
export type NativeOAuthDeviceConsent = {
  signal: AbortSignal;
  close: () => void;
};
export type NativeOAuthImplicitAuthorization = {
  state: string;
  redirectUri: string;
  authorize: (
    url: string,
    options: { expiresAt: number },
  ) => Promise<IssuedNativeOAuthToken>;
  close: () => void;
};
export type NativeOAuthBrowserPort = {
  redirectUri: string;
  navigate: (url: string) => void;
  scrubCallback: () => void;
  /** Reserve the consent window synchronously before any discovery request. */
  prepareAuthorization?: () => () => void;
  /** Return to the initiating unlocked runtime instead of navigating its tab. */
  authorize?: (
    url: string,
    options: {
      state: string;
      expiresAt: number;
      redirectUri?: string;
      responseMode?: "query" | "web_message.opener";
      expectedOrigin?: string;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
  deviceConsent?: (
    request: NativeOAuthDeviceConsentRequest,
  ) => NativeOAuthDeviceConsent;
  cancelAuthorization?: () => void;
  prepareImplicitAuthorization?: (
    providerId: string,
  ) => Promise<NativeOAuthImplicitAuthorization>;
  googleToken?: (
    clientId: string,
    scopes: readonly string[],
    retain: (token: IssuedNativeOAuthToken) => Promise<void>,
    assertCurrent: () => void,
  ) => Promise<void>;
};
let active: NativeOAuthBrowserPort | null = null;

export function bindNativeOAuthBrowserPort(
  port: NativeOAuthBrowserPort,
): () => void {
  const redirect = new URL(port.redirectUri);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    redirect.hostname,
  );
  if (
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && loopback)) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error("Register a secure native connector callback URL");
  active = port;
  return () => {
    if (active === port) active = null;
  };
}
export function nativeOAuthBrowserPort(): NativeOAuthBrowserPort {
  if (!active)
    throw new Error("Browser connector authorization is unavailable");
  return active;
}
export function optionalNativeOAuthBrowserPort(): NativeOAuthBrowserPort | null {
  return active;
}
export function nativeOAuthRedirectUri(): string {
  return nativeOAuthBrowserPort().redirectUri;
}
