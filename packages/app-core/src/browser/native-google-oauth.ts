/** Google consent runs in a reserved page with a fresh user gesture for GIS. */
import type { IssuedNativeOAuthToken } from "../lib/native-browser-oauth-token.js";
import { nativeOAuthBrowserPort } from "../lib/native-oauth-browser-port.js";
import { nativeGoogleBrowserAvailable } from "./native-google-capability.js";
export { nativeGoogleBrowserAvailable } from "./native-google-capability.js";

export async function requestNativeGoogleToken(
  clientId: string,
  scopes: readonly string[],
  retain: (token: IssuedNativeOAuthToken) => Promise<void>,
  assertCurrent: () => void,
): Promise<void> {
  if (!nativeGoogleBrowserAvailable())
    throw new Error(
      "Google GIS popup authorization is unavailable with enforced Cross-Origin-Opener-Policy same-origin",
    );
  assertCurrent();
  const prepare = nativeOAuthBrowserPort().prepareImplicitAuthorization;
  if (!prepare) throw new Error("Google consent window is unavailable");
  const authorization = await prepare("google");
  try {
    assertCurrent();
    const expiresAt = Date.now() + 600_000;
    const url = new URL(authorization.redirectUri);
    url.hash = new URLSearchParams({
      clientId,
      scopes: JSON.stringify(scopes),
      state: authorization.state,
      expiresAt: String(expiresAt),
    }).toString();
    // The receiver seals the minted token before acknowledging encrypted delivery.
    await authorization.authorize(url.href, { expiresAt, retain });
  } finally {
    authorization.close();
  }
}
