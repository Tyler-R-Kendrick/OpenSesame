import { requiredBrowserOAuthProfile } from "../lib/native-browser-oauth-profile.js";
/** Optional capability-owned bridge to Google's official GIS browser token SDK. */
import {
  type IssuedNativeOAuthToken,
  parseNativeOAuthToken,
} from "../lib/native-browser-oauth-token.js";
import { NativeOAuthError } from "../lib/native-oauth-errors.js";

type GoogleTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};
type GoogleTokenClient = {
  requestAccessToken: (options: { prompt: string }) => void;
};
type GoogleIdentitySdk = {
  accounts: {
    oauth2: {
      initTokenClient: (options: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: GoogleTokenResponse) => void;
        error_callback: () => void;
      }) => GoogleTokenClient;
    };
  };
};
declare global {
  interface Window {
    google?: GoogleIdentitySdk;
  }
}
declare const __NATIVE_GOOGLE_HEADER_SECURITY__: boolean;
export function nativeGoogleBrowserAvailable(): boolean {
  return !__NATIVE_GOOGLE_HEADER_SECURITY__ && !globalThis.crossOriginIsolated;
}
let loading: Promise<GoogleIdentitySdk> | null = null;

function loadGoogleSdk(): Promise<GoogleIdentitySdk> {
  if (window.google) return Promise.resolve(window.google);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.referrerPolicy = "no-referrer";
    const deadline = setTimeout(() => {
      script.remove();
      loading = null;
      reject(new NativeOAuthError("network"));
    }, 15_000);
    script.onload = () => {
      clearTimeout(deadline);
      if (window.google) resolve(window.google);
      else {
        loading = null;
        reject(new NativeOAuthError("provider"));
      }
    };
    script.onerror = () => {
      clearTimeout(deadline);
      script.remove();
      loading = null;
      reject(new NativeOAuthError("network"));
    };
    document.head.append(script);
  });
  return loading;
}
export async function requestNativeGoogleToken(
  clientId: string,
  scopes: readonly string[],
  retain: (token: IssuedNativeOAuthToken) => Promise<void>,
  assertCurrent: () => void,
): Promise<void> {
  if (!nativeGoogleBrowserAvailable())
    throw new Error(
      "Google GIS popup authorization is unavailable with enforced Cross-Origin-Opener-Policy same-origin; use a header-less browser deployment or a supported provider route without weakening vault isolation",
    );
  const sdk = await loadGoogleSdk();
  assertCurrent();
  return new Promise((resolve, reject) => {
    let received = false;
    const client = sdk.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes.join(" "),
      include_granted_scopes: false,
      callback: (response) => {
        if (received) return;
        received = true;
        if (response.error && !response.access_token) {
          reject(new NativeOAuthError("denied"));
          return;
        }
        let token: IssuedNativeOAuthToken;
        try {
          token = parseNativeOAuthToken(
            {
              access_token: response.access_token ?? null,
              token_type: response.token_type ?? null,
              expires_in: response.expires_in ?? null,
              scope: response.scope ?? null,
            },
            requiredBrowserOAuthProfile("google"),
          );
        } catch {
          reject(new NativeOAuthError("provider"));
          return;
        }
        retain({
          ...token,
          protocolValid: token.protocolValid && !response.error,
        }).then(resolve, reject);
      },
      error_callback: () => {
        if (!received) reject(new NativeOAuthError("network"));
      },
    });
    client.requestAccessToken({ prompt: "consent" });
  });
}
