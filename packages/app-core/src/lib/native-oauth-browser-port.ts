/** Browser navigation and popup authorization are installed by the optional connector runtime. */
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";

export type NativeOAuthBrowserPort = {
  redirectUri: string;
  navigate: (url: string) => void;
  scrubCallback: () => void;
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
export function nativeOAuthRedirectUri(): string {
  return nativeOAuthBrowserPort().redirectUri;
}
