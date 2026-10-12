/** A click reserves consent; its return is delivered to the same unlocked runtime. */
import {
  type NativeAuthPopup,
  reserveNativeAuthPopup,
} from "@opensesame/app-core/browser/native-auth-session.js";
import type {
  NativeOAuthBrowserPort,
  NativeOAuthDeviceConsentRequest,
} from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Activation } from "../activation.js";
import { nativeImplicitAuthorization } from "./native-implicit-runtime.js";

type PopupSession = {
  prepare: () => () => void;
  popup: () => NativeAuthPopup;
  release: (popup: NativeAuthPopup) => void;
  close: (popup: NativeAuthPopup) => void;
  captureGuard: () => () => void;
  cancel: () => void;
  assertCurrent: () => void;
  signal: () => AbortSignal;
};
type Authorize = NonNullable<NativeOAuthBrowserPort["authorize"]>;

function popupSession(
  activation: Activation,
  assertCurrent: () => void,
): PopupSession {
  let reserved: { popup: NativeAuthPopup; controller: AbortController } | null =
    null;
  const lifetime = new AbortController();
  const cancel = () => {
    reserved?.controller.abort();
    reserved?.popup.cancel();
    reserved = null;
  };
  const release = (popup: NativeAuthPopup) => {
    popup.cancel();
    if (reserved?.popup === popup) {
      reserved.controller.abort();
      reserved = null;
    }
  };
  const prepare = () => {
    assertCurrent();
    if (reserved) throw new Error("Finish the current provider sign-in first");
    const popup = reserveNativeAuthPopup();
    reserved = { popup, controller: new AbortController() };
    return () => release(popup);
  };
  const stopLock = vaultStore.onLock(cancel);
  activation.onDispose(() => {
    stopLock();
    lifetime.abort();
    cancel();
  });
  return {
    prepare,
    release,
    close: (popup) => popup.cancel(),
    captureGuard: () => {
      if (!reserved)
        throw new Error("Reserve a fresh provider sign-in window first");
      const signal = reserved.controller.signal;
      return () => {
        assertCurrent();
        lifetime.signal.throwIfAborted();
        signal.throwIfAborted();
      };
    },
    cancel,
    assertCurrent,
    signal: () => {
      if (!reserved)
        throw new Error("Reserve a fresh provider sign-in window first");
      return AbortSignal.any([lifetime.signal, reserved.controller.signal]);
    },
    popup: () => {
      assertCurrent();
      if (!reserved)
        throw new Error("Reserve a fresh provider sign-in window first");
      return reserved.popup;
    },
  };
}

async function authorizePopup(
  session: PopupSession,
  redirectUri: string,
  authorizationUrl: string,
  options: Parameters<Authorize>[1],
): Promise<string> {
  const popup = session.popup();
  const signal = session.signal();
  try {
    const request = {
      authorizationUrl,
      state: options.state,
      expiresAt: options.expiresAt,
      signal: options.signal
        ? AbortSignal.any([signal, options.signal])
        : signal,
    };
    const response =
      options.responseMode === "web_message.opener"
        ? await popup.waitWebMessage({
            ...request,
            expectedOrigin: options.expectedOrigin ?? "",
          })
        : await popup.wait({
            ...request,
            redirectUri: options.redirectUri ?? redirectUri,
          });
    session.assertCurrent();
    const search = new URLSearchParams({ native_state: response.state });
    if (response.error) search.set("native_error", "access_denied");
    else if (response.code) search.set("native_code", response.code);
    return search.toString();
  } finally {
    session.close(popup);
  }
}

function deviceConsent(
  session: PopupSession,
  request: NativeOAuthDeviceConsentRequest,
) {
  const popup = session.popup();
  const signal = session.signal();
  const consent = popup.showDeviceConsent(request);
  return {
    signal: AbortSignal.any([signal, consent.signal]),
    close: () => {
      consent.close();
      session.close(popup);
    },
  };
}

async function prepareImplicit(session: PopupSession, providerId: string) {
  const popup = session.popup();
  const signal = session.signal();
  try {
    return await nativeImplicitAuthorization(
      providerId,
      popup,
      signal,
      session.assertCurrent,
      () => session.close(popup),
    );
  } catch (error) {
    session.close(popup);
    throw error;
  }
}

export function nativeAuthPopupRuntime(
  activation: Activation,
  redirectUri: string,
  assertCurrent: () => void,
): Pick<
  NativeOAuthBrowserPort,
  | "prepareAuthorization"
  | "captureAuthorizationGuard"
  | "authorize"
  | "deviceConsent"
  | "cancelAuthorization"
  | "prepareImplicitAuthorization"
> {
  const session = popupSession(activation, assertCurrent);
  return {
    prepareAuthorization: session.prepare,
    captureAuthorizationGuard: session.captureGuard,
    cancelAuthorization: session.cancel,
    deviceConsent: (request) => deviceConsent(session, request),
    prepareImplicitAuthorization: (providerId) =>
      prepareImplicit(session, providerId),
    authorize: (url, options) =>
      authorizePopup(session, redirectUri, url, options),
  };
}
