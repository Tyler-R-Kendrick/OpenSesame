/** A returned bearer is encrypted to this consent window's originating runtime. */
import type { NativeAuthPopup } from "@opensesame/app-core/browser/native-auth-session.js";
import type { NativeImplicitToken } from "@opensesame/app-core/browser/native-implicit-crypto.js";
import {
  NativeImplicitDeniedError,
  createNativeImplicitReceiver,
} from "@opensesame/app-core/browser/native-implicit-session.js";
import { requiredBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  type IssuedNativeOAuthToken,
  parseNativeOAuthToken,
} from "@opensesame/app-core/lib/native-browser-oauth-token.js";
import type { NativeOAuthImplicitAuthorization } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { NativeOAuthError } from "@opensesame/app-core/lib/native-oauth-errors.js";

function issuedToken(provider: string, payload: NativeImplicitToken) {
  const token = parseNativeOAuthToken(
    {
      access_token: payload.accessToken,
      token_type: payload.tokenType,
      expires_in: payload.expiresIn ?? undefined,
      scope: payload.scopes?.join(" "),
    },
    requiredBrowserOAuthProfile(provider),
  );
  return {
    ...token,
    protocolValid: token.protocolValid && payload.protocolValid !== false,
  };
}

export async function nativeImplicitAuthorization(
  providerId: string,
  popup: NativeAuthPopup,
  lifetime: AbortSignal,
  assertCurrent: () => void,
  release: () => void,
): Promise<NativeOAuthImplicitAuthorization> {
  if (
    providerId !== "discord" &&
    providerId !== "reddit" &&
    providerId !== "google"
  )
    throw new Error("This provider does not support browser token consent");
  const provider = providerId;
  const route = provider === "google" ? "native-google" : "native-implicit";
  const redirectUri = new URL(
    `${import.meta.env.BASE_URL}auth/${route}.html`,
    window.location.origin,
  ).href;
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const receiver = await createNativeImplicitReceiver({
    providerId: provider,
    redirectUri,
    nonce,
  });
  const close = () => {
    receiver.close();
    release();
  };
  try {
    lifetime.throwIfAborted();
    assertCurrent();
    return {
      state: receiver.state,
      redirectUri,
      close,
      authorize: async (authorizationUrl, options) => {
        assertCurrent();
        const consent = popup.showRedirectConsent({
          authorizationUrl,
          state: receiver.state,
          expiresAt: options.expiresAt,
        });
        const signal = AbortSignal.any([lifetime, consent.signal]);
        let retained: IssuedNativeOAuthToken | null = null;
        try {
          await receiver.wait({
            expiresAt: options.expiresAt,
            signal,
            assertCurrent,
            retain: async (payload) => {
              const token = issuedToken(provider, payload);
              await options.retain(token);
              retained = token;
            },
          });
          if (signal.aborted) throw new NativeOAuthError("denied");
          assertCurrent();
          if (!retained) throw new NativeOAuthError("provider");
          return retained;
        } catch (error) {
          if (error instanceof NativeImplicitDeniedError)
            throw new NativeOAuthError("denied");
          throw error;
        } finally {
          consent.close();
          close();
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
