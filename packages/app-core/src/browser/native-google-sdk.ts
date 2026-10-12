/** Google's official browser token client is invoked synchronously by the consent button. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { requiredBrowserOAuthProfile } from "../lib/native-browser-oauth-profile.js";
import {
  type IssuedNativeOAuthToken,
  parseNativeOAuthToken,
} from "../lib/native-browser-oauth-token.js";
import { NativeOAuthError } from "../lib/native-oauth-errors.js";
import { nativeGoogleBrowserAvailable } from "./native-google-capability.js";
export type GoogleTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};
export type GoogleIdentitySdk = {
  accounts: {
    oauth2: {
      initTokenClient: (options: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: GoogleTokenResponse) => void;
        error_callback: () => void;
      }) => { requestAccessToken: (options: { prompt: string }) => void };
      revoke: (
        token: string,
        callback: (response: { successful?: boolean }) => void,
      ) => void;
    };
  };
};
declare global {
  interface Window {
    google?: GoogleIdentitySdk;
  }
}
export async function loadNativeGoogleSdk(
  signal: AbortSignal,
): Promise<GoogleIdentitySdk> {
  if (!nativeGoogleBrowserAvailable()) throw new NativeOAuthError("provider");
  signal.throwIfAborted();
  if (window.google) return window.google;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.referrerPolicy = "no-referrer";
    const finish = (error?: NativeOAuthError) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else if (window.google) resolve(window.google);
      else reject(new NativeOAuthError("provider"));
    };
    const cancel = () => finish(new NativeOAuthError("expired"));
    const deadline = setTimeout(
      () => finish(new NativeOAuthError("network")),
      15_000,
    );
    script.onload = () => finish();
    script.onerror = () => finish(new NativeOAuthError("network"));
    signal.addEventListener("abort", cancel, { once: true });
    document.head.append(script);
  });
}
export function requestNativeGoogleSdkConsent(
  sdk: GoogleIdentitySdk,
  request: { clientId: string; scopes: readonly string[]; expiresAt: number },
  receive: (token: IssuedNativeOAuthToken) => void,
  fail: (error: NativeOAuthError) => void,
): void {
  if (Date.now() >= request.expiresAt) {
    fail(new NativeOAuthError("expired"));
    return;
  }
  let received = false;
  const client = sdk.accounts.oauth2.initTokenClient({
    client_id: request.clientId,
    scope: request.scopes.join(" "),
    include_granted_scopes: false,
    callback: (response) => {
      if (received) return;
      received = true;
      if (response.error && !response.access_token) {
        fail(new NativeOAuthError("denied"));
        return;
      }
      try {
        const body: BoundaryValue = {
          access_token: response.access_token ?? null,
          token_type: response.token_type ?? null,
          expires_in: response.expires_in ?? null,
          scope: response.scope ?? null,
        };
        const token = parseNativeOAuthToken(
          body,
          requiredBrowserOAuthProfile("google"),
        );
        receive({
          ...token,
          protocolValid: token.protocolValid && !response.error,
        });
      } catch {
        fail(new NativeOAuthError("provider"));
      }
    },
    error_callback: () => {
      if (!received) {
        received = true;
        fail(new NativeOAuthError("network"));
      }
    },
  });
  client.requestAccessToken({ prompt: "consent" });
}

export function revokeNativeGoogleSdkToken(
  sdk: GoogleIdentitySdk,
  accessToken: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new NativeOAuthError("cleanup")),
      15_000,
    );
    sdk.accounts.oauth2.revoke(accessToken, (response) => {
      clearTimeout(timeout);
      if (response.successful) resolve();
      else reject(new NativeOAuthError("cleanup"));
    });
  });
}
